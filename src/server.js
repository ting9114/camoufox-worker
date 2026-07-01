import express from 'express';
import { firefox } from 'playwright';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolveAdPatterns } from './ad-patterns.js';
import { solveTurnstile, hasTurnstile } from './cf-solver.js';
import { generateFingerprint, fingerprintSummary } from './fingerprint.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

// Camoufox binary path (extracted in Docker image)
const CAMOUFOX_PATH = process.env.CAMOUFOX_PATH || '/opt/camoufox/camoufox-bin';

// Bearer token auth (set ACCESS_KEY env var to enable)
const ACCESS_KEY = process.env.ACCESS_KEY || '';

function authMiddleware(req, res, next) {
  if (!ACCESS_KEY) return next(); // no key configured = open (dev mode)
  if (req.path === '/health') return next(); // health check always open
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token !== ACCESS_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}
app.use(authMiddleware);

// session id -> { sessionId, browser, context, page, ttl, timer, fingerprint, ... }
const sessions = new Map();

/* ─────────────────────── Session Management ─────────────────────── */

function resetTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    console.log(`[session:${sessionId}] TTL expired (${session.ttl}ms)`);
    closeSession(sessionId);
  }, session.ttl);
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.closing) return;
  session.closing = true;
  clearTimeout(session.timer);
  try { await session.browser.close(); } catch {}
  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}

async function createSession(options = {}) {
  const {
    ttl = 30000,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = '',
    proxy = null,
    cookies = [],
    timezone = '',
    os = '',        // Force OS fingerprint: 'windows', 'macos', 'linux'
    fingerprint: fpOverride = null, // Custom fingerprint config overrides
  } = options;

  const sessionId = randomUUID();

  // Generate anti-detection fingerprint
  const fp = generateFingerprint({
    os: os || undefined,
    timezone: timezone || undefined,
    ...(fpOverride || {}),
  });

  console.log(`[session:${sessionId}] Fingerprint:`, fingerprintSummary(fp));

  // Camoufox launch options — no Chrome args needed, Firefox handles everything
  const launchOptions = {
    executablePath: CAMOUFOX_PATH,
    headless: false, // Using Xvfb virtual display (better anti-detection than native headless)
    env: {
      ...process.env,
      CAMOU_CONFIG: JSON.stringify(fp.config),
      MOZ_DISABLE_WAYLAND: '1',
      MOZ_DISABLE_GFX_SANDBOX: '1',
      LIBGL_ALWAYS_SOFTWARE: '1',
      GALLIUM_DRIVER: 'llvmpipe',
      MOZ_WEBRENDER: '0',
      MOZ_ACCELERATED: '0',
    },
    firefoxUserPrefs: {
      // Privacy/anti-detection prefs
      'privacy.resistFingerprinting': false,  // Camoufox handles this via C++ patches
      'dom.webdriver.enabled': false,
      'media.peerconnection.enabled': true,
      'network.http.referer.XOriginPolicy': 0,
      // Fix WASM crash: "wasm_rt_syscall_set_segue_base error: Invalid argument"
      'javascript.options.wasm_segue': false,
      // Disable GPU-related features that crash in containers without GPU
      'gfx.x11-egl.force-enabled': false,
      'widget.dmabuf.force-enabled': false,
    },
  };

  // Proxy support
  if (proxy && proxy.server) {
    launchOptions.proxy = {
      server: proxy.server,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    };
  }

  console.log(`[session:${sessionId}] Launching Camoufox (os: ${fp.os}, proxy: ${proxy?.server || 'none'})...`);
  const browser = await firefox.launch(launchOptions);

  // Create browser context with fingerprint-matched settings
  // Camoufox's Juggler protocol rejects isMobile/deviceScaleFactor in viewport.
  // Setting viewport to null lets Camoufox use its own dimensions from CAMOU_CONFIG.
  const contextOptions = {
    userAgent: fp.userAgent,
    viewport: null,
    locale: fp.locale,
    timezoneId: fp.timezone,
    ignoreHTTPSErrors: disableSecurity,
    javaScriptEnabled: true,
  };

  const context = await browser.newContext(contextOptions);

  // Inject Camoufox per-context init script (self-destructing C++ setters)
  await context.addInitScript(fp.initScript);

  // CSS injection (if requested)
  if (addCSS) {
    await context.addInitScript(({ css }) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.documentElement.appendChild(style);
    }, { css: addCSS });
  }

  // JS injection (if requested — note: Camoufox already handles stealth)
  if (addJS) {
    await context.addInitScript((js) => {
      const script = document.createElement('script');
      script.textContent = js;
      document.documentElement.appendChild(script);
    }, addJS);
  }

  // No manual stealth injection needed — Camoufox patches navigator.webdriver,
  // automation indicators, and Juggler scope isolation at the C++ level.

  // Inject cookies at session creation
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
    console.log(`[session:${sessionId}] Injected ${cookies.length} cookies`);
  }

  const page = await context.newPage();
  const forceHttpHosts = Array.isArray(forceHttp) ? new Set(forceHttp) : new Set();

  const sessionObj = {
    sessionId, browser, context, page, ttl,
    blockAds, forceHttp, forceHttpHosts,
    proxy: proxy || null,
    captcha: options.captcha || null,
    fingerprint: fingerprintSummary(fp),
  };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created (Camoufox ${fp.os})`);
  return sessionObj;
}

/* ─────────────────────── Route Setup ─────────────────────── */

async function setupRoutes(session) {
  const { context, sessionId, forceHttp, forceHttpHosts, blockAds } = session;
  await context.unroute('**/*');

  const patterns = resolveAdPatterns(blockAds);
  const adBlockingEnabled = patterns !== null;
  const forceHttpActive = forceHttp === true || forceHttpHosts.size > 0;

  if (!forceHttpActive && !adBlockingEnabled) return;

  await context.route('**/*', async (route) => {
    const urlStr = route.request().url();
    const urlLower = urlStr.toLowerCase();

    const isAd = adBlockingEnabled && patterns.some(p => urlLower.includes(p));
    if (isAd) {
      console.log(`[session:${sessionId}] AdBlock: ${urlStr}`);
      return route.abort();
    }

    let url = null;
    try { url = new URL(urlStr); } catch {}
    const hostname = url?.hostname?.toLowerCase();

    const shouldForceHttp = forceHttp === true || (hostname && forceHttpHosts.has(hostname));
    if (shouldForceHttp && url.protocol === 'https:') {
      const httpUrl = urlStr.replace(/^https:/, 'http:');
      try {
        const response = await route.fetch({ url: httpUrl });
        await route.fulfill({ response });
        return;
      } catch {}
    }

    route.continue();
  });
}

/* ─────────────────────── Step Executor ─────────────────────── */

async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context } = session;

  switch (action) {
    case 'goto': {
      try {
        const targetUrl = new URL(params.url);
        if (targetUrl.protocol === 'http:') {
          session.forceHttpHosts.add(targetUrl.hostname.toLowerCase());
        }
        await setupRoutes(session);
      } catch (e) {
        return { error: `Invalid URL: ${params.url}` };
      }
      await page.goto(params.url, {
        waitUntil: params.waitUntil ?? 'domcontentloaded',
        timeout: params.timeout ?? 60000
      });
      return { url: page.url() };
    }
    case 'reload':
      await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
      return { url: page.url() };
    case 'getUrl':
      return { url: page.url() };
    case 'getContent':
      return { html: await page.content() };
    case 'click':
      await page.click(params.selector, { timeout: params.timeout ?? 30000 });
      return { clicked: params.selector };
    case 'fill':
      await page.fill(params.selector, params.value);
      return { filled: params.selector };
    case 'type':
      await page.type(params.selector, params.text, { delay: params.delay ?? 30 });
      return { typed: params.selector };
    case 'select':
      await page.selectOption(params.selector, params.value);
      return { selected: params.value };
    case 'check':
      params.state === false
        ? await page.uncheck(params.selector)
        : await page.check(params.selector);
      return { checked: params.selector };
    case 'keyboard':
      await page.keyboard.press(params.key);
      return { pressed: params.key };
    case 'hover':
      await page.hover(params.selector);
      return { hovered: params.selector };
    case 'wait':
      await page.waitForTimeout(params.ms ?? 1000);
      return { waited: params.ms };
    case 'waitForSelector':
      await page.waitForSelector(params.selector, {
        state: params.state ?? 'visible',
        timeout: params.timeout ?? 30000
      });
      return { found: params.selector };
    case 'waitForNavigation':
      await page.waitForLoadState(params.waitUntil ?? 'networkidle');
      return { url: page.url() };
    case 'evaluate':
      return { value: await page.evaluate(params.script) };
    case 'getText':
      return { text: await page.textContent(params.selector) };
    case 'getAttribute':
      return { value: await page.getAttribute(params.selector, params.attr) };
    case 'screenshot': {
      const opts = { type: 'png', fullPage: params.fullPage ?? false };
      const buf = params.selector
        ? await page.locator(params.selector).screenshot(opts)
        : await page.screenshot(opts);
      return { screenshot: buf.toString('base64') };
    }
    case 'getCookies':
      return { cookies: await context.cookies() };
    case 'setCookies':
      await context.addCookies(params.cookies);
      return { set: params.cookies.length };
    case 'getLocalStorage':
      return { value: await page.evaluate((k) => localStorage.getItem(k), params.key) };
    case 'uploadFile': {
      const { selector, filename = 'upload.csv', base64: fileBase64, force = true } = params;
      if (!fileBase64) throw new Error('uploadFile: base64 param is required');
      const uploadDir = '/tmp/bw-uploads';
      mkdirSync(uploadDir, { recursive: true });
      const filePath = join(uploadDir, filename);
      writeFileSync(filePath, Buffer.from(fileBase64, 'base64'));
      await page.setInputFiles(selector, filePath, { force });          // ← force: true added
      try { await page.dispatchEvent(selector, 'change', {}, { force }); } catch {} // ← added
      try { unlinkSync(filePath); } catch {}
      return { uploaded: filename };
    }

    /* ──────── Cloudflare-specific actions ──────── */

    case 'solveTurnstile': {
      if (!session.captcha || !session.captcha.apiKey) {
        throw new Error('captcha config with apiKey required. Add "captcha": {"provider": "2captcha", "apiKey": "..."} to request body.');
      }
      const result = await solveTurnstile(page, session.captcha, session.proxy, params);
      return result;
    }

    case 'detectTurnstile': {
      const detection = await hasTurnstile(page);
      return detection;
    }

    case 'waitForCfClearance': {
      const maxWait = params.timeout || 60000;
      const pollMs = params.poll || 2000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const cookies = await context.cookies();
        const cf = cookies.find(c => c.name === 'cf_clearance');
        if (cf) return { found: true, cf_clearance: cf.value, elapsed: Date.now() - start };
        await page.waitForTimeout(pollMs);
      }
      return { found: false, elapsed: Date.now() - start };
    }

    default:
      if (typeof page[action] === 'function') {
        const result = await page[action](params);
        return { result };
      }
      throw new Error(`Unknown action: "${action}"`);
  }
}

/* ─────────────────────── HTTP Endpoints ─────────────────────── */

app.post('/execute', async (req, res) => {
  const {
    sessionId,
    ttl,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = '',
    proxy,
    cookies,
    timezone,
    captcha,
    os,
    fingerprint,
    steps = [],
    stopOnError = true
  } = req.body;

  if (!steps.length) return res.status(400).json({ ok: false, error: 'steps required' });

  let session = sessionId ? sessions.get(sessionId) : null;
  if (sessionId && !session) return res.status(404).json({ ok: false, error: 'Session expired' });

  if (!session) {
    try {
      session = await createSession({
        ttl: ttl || 30000, blockAds, forceHttp, disableSecurity,
        addCSS, addJS, proxy, cookies, timezone, captcha, os, fingerprint
      });
    } catch (err) {
      console.error('[createSession] Error:', err.message);
      return res.status(503).json({ ok: false, error: err.message });
    }
  } else {
    if (ttl) {
      session.ttl = ttl;
      console.log(`[session:${session.sessionId}] TTL updated to ${ttl}ms`);
    }
    if (captcha) session.captcha = captcha;
  }

  const results = [];
  let error = null;
  for (const step of steps) {
    session.busy = true;
    try {
      console.log(`[session:${session.sessionId}] action: ${step.action}`, step.params || {});
      const result = await executeStep(session, step);
      results.push({ action: step.action, ok: true, result });
    } catch (e) {
      console.error(`[session:${session.sessionId}] error in ${step.action}:`, e.message);
      results.push({ action: step.action, ok: false, error: e.message });
      error = e.message;
      if (stopOnError) break;
    } finally {
      session.busy = false;
    }
  }

  resetTimer(session.sessionId);

  let finalUrl = null;
  try {
    finalUrl = session?.page && !session.page.isClosed() ? session.page.url() : null;
  } catch {}

  res.json({
    ok: !error,
    sessionId: session.sessionId,
    results,
    finalUrl,
    fingerprint: session.fingerprint,
    error: error || undefined
  });
});

app.get('/health', (req, res) => res.json({
  ok: true,
  engine: 'camoufox',
  sessions: sessions.size
}));

app.get('/sessions', (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    ttl: s.ttl,
    url: s.page.url(),
    fingerprint: s.fingerprint,
  }));
  res.json({ count: list.length, sessions: list });
});

app.get('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, sessionId: req.params.id, url: s.page.url(), ttl: s.ttl, fingerprint: s.fingerprint });
});

app.delete('/sessions/:id', async (req, res) => {
  if (!sessions.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found' });
  await closeSession(req.params.id);
  res.json({ ok: true });
});

/* ─────────────────────── Start ─────────────────────── */

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Camoufox Worker ready on :${PORT}`);
  console.log(`  Engine: Camoufox (patched Firefox) — C++ level anti-detection`);
  console.log(`  Binary: ${CAMOUFOX_PATH}`);
  console.log(`  Display: ${process.env.DISPLAY || 'headless'}`);
});

process.on('uncaughtException', (err) => console.error('[FATAL] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL] unhandledRejection:', reason));
process.on('SIGTERM', () => console.error('[PROCESS] SIGTERM received'));
process.on('SIGINT', () => console.error('[PROCESS] SIGINT received'));

setInterval(() => {
  console.log(`[PROCESS] alive sessions=${sessions.size} uptime=${Math.round(process.uptime())}s`);
}, 60000);
