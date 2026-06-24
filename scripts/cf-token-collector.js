#!/usr/bin/env node
/**
 * Cloudflare API Token Collector
 * ================================
 * Standalone backup script that uses the Camoufox worker to:
 * 1. Log into each Cloudflare account
 * 2. Check if an API token exists
 * 3. If yes — copy it
 * 4. If no — create one (Zone DNS Edit for all zones)
 * 5. Save results to output file
 *
 * Usage:
 *   node scripts/cf-token-collector.js \
 *     --accounts accounts.json \
 *     --proxies proxies.txt \
 *     --output results.json \
 *     --worker http://localhost:3003
 *
 * accounts.json format:
 *   [
 *     { "email": "user@example.com", "password": "pass123" },
 *     ...
 *   ]
 *
 * proxies.txt format (one per line):
 *   http://user:pass@host:port
 *   http://user:pass@host:port
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { argv } from 'process';

/* ─────────────────────── Config ─────────────────────── */

const args = parseArgs(argv.slice(2));
const WORKER_URL = args.worker || 'http://localhost:3003';
const CAPTCHA_KEY = args.captchaKey || '655fa9f385d532059db94fb1b0f94adb';
const TOKEN_NAME = args.tokenName || 'dns_api_token';
const ACCOUNTS_FILE = args.accounts || 'accounts.json';
const PROXIES_FILE = args.proxies || 'proxies.txt';
const OUTPUT_FILE = args.output || 'results.json';
const DELAY_BETWEEN = parseInt(args.delay || '10000'); // ms between accounts

/* ─────────────────────── Helpers ─────────────────────── */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

function loadAccounts() {
  const raw = readFileSync(ACCOUNTS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function loadProxies() {
  if (!existsSync(PROXIES_FILE)) return [];
  return readFileSync(PROXIES_FILE, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickOS() {
  const r = Math.random();
  if (r < 0.75) return 'windows';
  if (r < 0.95) return 'macos';
  return 'linux';
}

function parseProxy(proxyStr) {
  try {
    const url = new URL(proxyStr);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    return null;
  }
}

async function callWorker(body) {
  const resp = await fetch(`${WORKER_URL}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function closeSession(sessionId) {
  if (!sessionId) return;
  try {
    await fetch(`${WORKER_URL}/sessions/${sessionId}`, { method: 'DELETE' });
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getStepResult(results, action, index) {
  let count = 0;
  for (const r of results) {
    if (r.action === action) {
      if (count === index) return r;
      count++;
    }
  }
  return null;
}

function parseEval(result) {
  if (!result || !result.result || !result.result.value) return null;
  try {
    return typeof result.result.value === 'string'
      ? JSON.parse(result.result.value)
      : result.result.value;
  } catch { return result.result.value; }
}

/* ─────────────────────── Main Flow ─────────────────────── */

async function processAccount(account, proxy, index, total) {
  const { email, password } = account;
  const os = pickOS();
  const label = `[${index + 1}/${total}] ${email}`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label} — Starting (os=${os}, proxy=${proxy?.server || 'direct'})`);

  const result = {
    email,
    status: 'unknown',
    existingTokens: [],
    newToken: null,
    error: null,
    cookies: null,
    timestamp: new Date().toISOString(),
  };

  let sessionId = null;

  try {
    // ── Phase 1: Login ──
    console.log(`${label} — Phase 1: Login...`);
    const loginBody = {
      os,
      ttl: 600000,
      captcha: { provider: '2captcha', apiKey: CAPTCHA_KEY },
      ...(proxy ? { proxy } : {}),
      stopOnError: false,
      steps: [
        { action: 'goto', params: { url: 'https://dash.cloudflare.com/login', timeout: 90000 } },
        { action: 'wait', params: { ms: 10000 } },
        { action: 'solveTurnstile', params: { timeout: 120000 } },
        { action: 'wait', params: { ms: 3000 } },
        { action: 'click', params: { selector: "button:has-text('Accept All Cookies'), button:has-text('Reject All')", timeout: 5000 } },
        { action: 'wait', params: { ms: 1000 } },
        { action: 'fill', params: { selector: 'input[type=email]', value: email } },
        { action: 'fill', params: { selector: 'input[type=password]', value: password } },
        { action: 'click', params: { selector: 'button[type=submit]', timeout: 10000 } },
        { action: 'wait', params: { ms: 20000 } },
        { action: 'evaluate', params: { script: "(() => { return JSON.stringify({ url: location.href, loggedIn: !location.href.includes('/login') }); })()" } },
        { action: 'getCookies' },
      ],
    };

    const loginResult = await callWorker(loginBody);
    sessionId = loginResult.sessionId;

    const loginEval = parseEval(getStepResult(loginResult.results || [], 'evaluate', 0));
    if (!loginEval || !loginEval.loggedIn) {
      result.status = 'login_failed';
      result.error = loginResult.error || 'Login did not redirect to dashboard';
      console.log(`${label} — Login FAILED: ${result.error}`);
      return result;
    }

    // Save cookies
    const cookieStep = getStepResult(loginResult.results || [], 'getCookies', 0);
    if (cookieStep?.result?.cookies) {
      result.cookies = cookieStep.result.cookies;
    }

    console.log(`${label} — Login OK, navigating to API tokens...`);

    // ── Phase 2: Check existing tokens ──
    const checkBody = {
      sessionId,
      ttl: 600000,
      steps: [
        { action: 'goto', params: { url: 'https://dash.cloudflare.com/profile/api-tokens', timeout: 60000 } },
        { action: 'wait', params: { ms: 10000 } },
        { action: 'evaluate', params: { script: `(() => {
          var tokens = [];
          document.querySelectorAll('table tbody tr').forEach(function(tr) {
            var tds = tr.querySelectorAll('td');
            if (tds.length >= 2 && !tr.querySelector('.emptyState, [class*=empty]')) {
              var name = '';
              var h5 = tr.querySelector('h5 span');
              if (h5) name = h5.textContent.trim();
              var keyInput = tr.querySelector('input');
              var keyValue = keyInput ? keyInput.value : '';
              tokens.push({name: name, hasKey: !!keyValue, key: keyValue});
            }
          });
          var isEmpty = tokens.length === 0;
          return JSON.stringify({tokenCount: tokens.length, tokens: tokens, isEmpty: isEmpty});
        })()` } },
      ],
    };

    const checkResult = await callWorker(checkBody);
    const tokensInfo = parseEval(getStepResult(checkResult.results || [], 'evaluate', 0));

    if (tokensInfo && tokensInfo.tokens && tokensInfo.tokens.length > 0) {
      result.existingTokens = tokensInfo.tokens;
      console.log(`${label} — Found ${tokensInfo.tokens.length} existing token(s)`);

      // Check if any token has a visible key value
      const withKey = tokensInfo.tokens.filter(t => t.hasKey && t.key);
      if (withKey.length > 0) {
        result.status = 'existing_token_found';
        result.newToken = withKey[0].key;
        console.log(`${label} — Existing token key found: ${withKey[0].name}`);
        return result;
      }

      // Tokens exist but no key visible — we'll still create a new one
      console.log(`${label} — Tokens exist but no key visible, creating new...`);
    } else {
      console.log(`${label} — No existing tokens, creating new...`);
    }

    // ── Phase 3: Create new token ──
    console.log(`${label} — Phase 3: Creating API token...`);
    const createBody = {
      sessionId,
      ttl: 600000,
      stopOnError: false,
      steps: [
        // Click "Create Token"
        { action: 'click', params: { selector: "a:has-text('Create Token'), button:has-text('Create Token')", timeout: 10000 } },
        { action: 'wait', params: { ms: 5000 } },
        // Click "Get started" (Custom token)
        { action: 'click', params: { selector: "button:has-text('Get started'), a:has-text('Get started')", timeout: 10000 } },
        { action: 'wait', params: { ms: 5000 } },
        { action: 'screenshot', params: { fullPage: true } },

        // Fill token name
        { action: 'fill', params: { selector: 'input[name=name]', value: TOKEN_NAME } },
        { action: 'wait', params: { ms: 1000 } },

        // Select Zone (Downshift dropdown #cf-form-input1)
        { action: 'click', params: { selector: '#cf-form-input1', timeout: 5000 } },
        { action: 'wait', params: { ms: 2000 } },
        { action: 'evaluate', params: { script: `(() => { var items = document.querySelectorAll('#downshift-0-menu li'); for (var i = 0; i < items.length; i++) { if (items[i].textContent.trim().toLowerCase() === 'zone') { items[i].click(); return JSON.stringify({ok: true}); } } throw new Error('Zone not found'); })()` } },
        { action: 'wait', params: { ms: 2000 } },

        // Select DNS permission (Downshift combobox #cf-form-input2 — type to filter)
        { action: 'click', params: { selector: '#cf-form-input2', timeout: 5000 } },
        { action: 'wait', params: { ms: 1000 } },
        { action: 'type', params: { selector: '#cf-form-input2', text: 'dns', delay: 100 } },
        { action: 'wait', params: { ms: 2000 } },
        { action: 'evaluate', params: { script: `(() => { var items = document.querySelectorAll('#downshift-1-menu li'); for (var i = 0; i < items.length; i++) { if (items[i].textContent.trim().toLowerCase() === 'dns') { items[i].click(); return JSON.stringify({ok: true}); } } throw new Error('DNS not found'); })()` } },
        { action: 'wait', params: { ms: 2000 } },

        // Select Edit (React-Select — mousedown on control with "Select..." placeholder)
        { action: 'evaluate', params: { script: `(() => { var placeholders = document.querySelectorAll('[class*=react-select__placeholder]'); for (var i = 0; i < placeholders.length; i++) { if (placeholders[i].textContent.trim() === 'Select...') { var control = placeholders[i].closest('[class*=react-select__control]'); if (control) { control.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true})); return JSON.stringify({ok: true}); } } } throw new Error('Select... placeholder not found'); })()` } },
        { action: 'wait', params: { ms: 2000 } },
        { action: 'evaluate', params: { script: `(() => { var opts = document.querySelectorAll('[class*=react-select__option]'); for (var i = 0; i < opts.length; i++) { if (opts[i].textContent.trim().toLowerCase() === 'edit') { opts[i].click(); return JSON.stringify({ok: true}); } } throw new Error('Edit option not found'); })()` } },
        { action: 'wait', params: { ms: 2000 } },

        { action: 'screenshot', params: { fullPage: true } },

        // Click "Continue to summary"
        { action: 'click', params: { selector: "button:has-text('Continue to summary')", timeout: 10000 } },
        { action: 'wait', params: { ms: 5000 } },
        { action: 'screenshot', params: { fullPage: true } },

        // Click "Create Token" (final confirmation)
        { action: 'click', params: { selector: "button:has-text('Create Token')", timeout: 10000 } },
        { action: 'wait', params: { ms: 8000 } },
        { action: 'screenshot', params: { fullPage: true } },

        // Extract the created token
        { action: 'evaluate', params: { script: `(() => {
          var codeEl = document.querySelector('code, pre, input[readonly], [class*=secret]');
          if (codeEl) {
            var val = (codeEl.value || codeEl.textContent).trim();
            if (val.length > 20) return JSON.stringify({found: true, token: val});
          }
          var spans = document.querySelectorAll('span, p, div, td');
          for (var i = 0; i < spans.length; i++) {
            var t = spans[i].textContent.trim();
            if (t.match(/^[A-Za-z0-9_-]{35,}$/) && spans[i].children.length === 0)
              return JSON.stringify({found: true, token: t});
          }
          return JSON.stringify({found: false});
        })()` } },
      ],
    };

    const createResult = await callWorker(createBody);
    const tokenExtract = parseEval(getStepResult(createResult.results || [], 'evaluate', -1));

    if (tokenExtract && tokenExtract.found && tokenExtract.token) {
      result.status = 'token_created';
      result.newToken = tokenExtract.token;
      console.log(`${label} — Token CREATED: ${tokenExtract.token.substring(0, 20)}...`);
    } else {
      result.status = 'token_creation_attempted';
      result.error = 'Token created but could not extract value';
      console.log(`${label} — Token creation attempted but could not extract value`);

      // Save screenshots for debugging
      for (const r of (createResult.results || [])) {
        if (r.action === 'screenshot' && r.ok && r.result?.screenshot) {
          const buf = Buffer.from(r.result.screenshot, 'base64');
          const path = `/tmp/cf-debug-${email.replace(/[@.]/g, '_')}-${Date.now()}.png`;
          writeFileSync(path, buf);
          console.log(`${label} — Debug screenshot: ${path}`);
        }
      }
    }

    return result;

  } catch (err) {
    result.status = 'error';
    result.error = err.message;
    console.log(`${label} — ERROR: ${err.message}`);
    return result;

  } finally {
    // Always close session
    if (sessionId) {
      await closeSession(sessionId);
      console.log(`${label} — Session closed`);
    }
  }
}

/* ─────────────────────── Entry Point ─────────────────────── */

async function main() {
  console.log('Cloudflare API Token Collector');
  console.log('==============================');
  console.log(`Worker:    ${WORKER_URL}`);
  console.log(`Accounts:  ${ACCOUNTS_FILE}`);
  console.log(`Proxies:   ${PROXIES_FILE}`);
  console.log(`Output:    ${OUTPUT_FILE}`);
  console.log(`Token:     ${TOKEN_NAME}`);
  console.log();

  // Health check
  try {
    const health = await fetch(`${WORKER_URL}/health`).then(r => r.json());
    console.log(`Worker health: ${JSON.stringify(health)}`);
    if (!health.ok) throw new Error('Worker not healthy');
  } catch (err) {
    console.error(`Worker not reachable at ${WORKER_URL}: ${err.message}`);
    process.exit(1);
  }

  const accounts = loadAccounts();
  const proxies = loadProxies();
  console.log(`Loaded ${accounts.length} accounts, ${proxies.length} proxies\n`);

  // Load existing results if any
  let results = [];
  if (existsSync(OUTPUT_FILE)) {
    try {
      results = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
      console.log(`Loaded ${results.length} existing results from ${OUTPUT_FILE}`);
    } catch {}
  }

  const processed = new Set(results.map(r => r.email));

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    // Skip already processed
    if (processed.has(account.email)) {
      console.log(`\n[${i + 1}/${accounts.length}] ${account.email} — SKIPPED (already processed)`);
      continue;
    }

    // Pick random proxy
    const proxyStr = proxies.length > 0 ? pickRandom(proxies) : null;
    const proxy = proxyStr ? parseProxy(proxyStr) : null;

    const result = await processAccount(account, proxy, i, accounts.length);
    results.push(result);

    // Save after each account (in case of crash)
    writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${OUTPUT_FILE} (${results.length} total)`);

    // Delay between accounts
    if (i < accounts.length - 1) {
      const delay = DELAY_BETWEEN + Math.random() * 5000;
      console.log(`Waiting ${Math.round(delay / 1000)}s before next account...`);
      await sleep(delay);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const stats = {
    total: results.length,
    existing: results.filter(r => r.status === 'existing_token_found').length,
    created: results.filter(r => r.status === 'token_created').length,
    loginFailed: results.filter(r => r.status === 'login_failed').length,
    errors: results.filter(r => r.status === 'error').length,
  };
  console.log(`Total: ${stats.total}`);
  console.log(`Existing tokens found: ${stats.existing}`);
  console.log(`New tokens created: ${stats.created}`);
  console.log(`Login failures: ${stats.loginFailed}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`\nResults: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
