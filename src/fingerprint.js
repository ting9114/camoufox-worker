/**
 * Camoufox Fingerprint Generator
 * ===============================
 * Generates realistic browser fingerprint configs for Camoufox's CAMOU_CONFIG.
 * These values are applied at the C++ level inside the patched Firefox binary —
 * no JavaScript injection needed.
 *
 * Camoufox supports 92 configurable properties. We set the most impactful ones
 * for anti-detection and randomize seeds per session.
 */

import { randomInt } from 'crypto';

/* ─────────────────────── Presets ─────────────────────── */

const WINDOWS_PRESETS = [
  {
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    hardwareConcurrency: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  },
  {
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    hardwareConcurrency: 12,
    screen: { width: 2560, height: 1440, colorDepth: 24 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  },
  {
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    hardwareConcurrency: 16,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  },
  {
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    hardwareConcurrency: 8,
    screen: { width: 1366, height: 768, colorDepth: 24 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  },
  {
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    hardwareConcurrency: 4,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  },
];

const MACOS_PRESETS = [
  {
    platform: 'MacIntel',
    oscpu: 'Intel Mac OS X 10.15',
    hardwareConcurrency: 8,
    screen: { width: 1440, height: 900, colorDepth: 30 },
    webgl: { vendor: 'Apple', renderer: 'Apple M1' },
  },
  {
    platform: 'MacIntel',
    oscpu: 'Intel Mac OS X 10.15',
    hardwareConcurrency: 10,
    screen: { width: 1680, height: 1050, colorDepth: 30 },
    webgl: { vendor: 'Apple', renderer: 'Apple M2 Pro' },
  },
  {
    platform: 'MacIntel',
    oscpu: 'Intel Mac OS X 10.15',
    hardwareConcurrency: 12,
    screen: { width: 1920, height: 1080, colorDepth: 30 },
    webgl: { vendor: 'Apple', renderer: 'Apple M3 Pro' },
  },
];

const LINUX_PRESETS = [
  {
    platform: 'Linux x86_64',
    oscpu: 'Linux x86_64',
    hardwareConcurrency: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    webgl: { vendor: 'Mesa', renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)' },
  },
  {
    platform: 'Linux x86_64',
    oscpu: 'Linux x86_64',
    hardwareConcurrency: 16,
    screen: { width: 2560, height: 1440, colorDepth: 24 },
    webgl: { vendor: 'Mesa', renderer: 'AMD Radeon RX 580 Series (polaris10, LLVM 15.0.7, DRM 3.54)' },
  },
];

// Weighted OS distribution (roughly matches real-world Firefox traffic)
const OS_WEIGHTS = [
  { os: 'windows', weight: 75, presets: WINDOWS_PRESETS },
  { os: 'macos', weight: 20, presets: MACOS_PRESETS },
  { os: 'linux', weight: 5, presets: LINUX_PRESETS },
];

const TIMEZONES_BY_REGION = {
  us: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
  eu: ['Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Rome', 'Europe/Madrid'],
  asia: ['Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Seoul'],
};

const LOCALES_BY_OS = {
  windows: ['en-US', 'en-GB'],
  macos: ['en-US', 'en-GB'],
  linux: ['en-US'],
};

// Windows fonts (markers for CreepJS OS detection)
const WINDOWS_FONTS = [
  'Segoe UI', 'Tahoma', 'Cambria Math', 'Nirmala UI', 'Calibri',
  'Consolas', 'Arial', 'Times New Roman', 'Verdana', 'Georgia',
  'Trebuchet MS', 'Courier New', 'Impact', 'Comic Sans MS',
  'Lucida Console', 'Palatino Linotype', 'Garamond', 'Book Antiqua',
];

const MACOS_FONTS = [
  'Helvetica Neue', 'PingFang HK', 'PingFang SC', 'PingFang TC',
  'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia',
  'Menlo', 'Monaco', 'SF Pro', 'SF Mono', 'Avenir', 'Optima',
];

const LINUX_FONTS = [
  'Arimo', 'Cousine', 'Tinos', 'Twemoji Mozilla',
  'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono',
  'Liberation Sans', 'Liberation Serif', 'Liberation Mono',
  'Noto Sans', 'Noto Serif',
];

/* ─────────────────────── Helpers ─────────────────────── */

function pick(arr) {
  return arr[randomInt(0, arr.length)];
}

function weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = randomInt(0, total);
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

function randomSubset(arr, minPct, maxPct) {
  const min = Math.floor(arr.length * minPct);
  const max = Math.floor(arr.length * maxPct);
  const count = randomInt(min, max + 1);
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function seed() {
  return randomInt(1, 2 ** 32 - 1);
}

/* ─────────────────────── Main Generator ─────────────────────── */

/**
 * Generate a complete fingerprint config for Camoufox.
 *
 * @param {object} options
 * @param {string} [options.os] - Force OS: 'windows', 'macos', 'linux'. Random if omitted.
 * @param {string} [options.timezone] - Force timezone. Random US timezone if omitted.
 * @param {string} [options.locale] - Force locale. Matched to OS if omitted.
 * @param {string} [options.webrtcIp] - WebRTC IP to expose. Empty string disables.
 * @param {object} [options.screen] - Force screen: { width, height }.
 * @param {object} [options.webgl] - Force WebGL: { vendor, renderer }.
 * @returns {{ config: object, initScript: string, userAgent: string, viewport: object, os: string }}
 */
export function generateFingerprint(options = {}) {
  // Pick OS and preset
  let osChoice, preset;
  if (options.os) {
    const entry = OS_WEIGHTS.find(o => o.os === options.os);
    if (!entry) throw new Error(`Unknown OS: ${options.os}. Use windows, macos, or linux`);
    osChoice = entry.os;
    preset = pick(entry.presets);
  } else {
    const entry = weightedPick(OS_WEIGHTS);
    osChoice = entry.os;
    preset = pick(entry.presets);
  }

  // Override screen if requested
  const screen = options.screen || preset.screen;
  const webgl = options.webgl || preset.webgl;
  const timezone = options.timezone || pick(TIMEZONES_BY_REGION.us);
  const locale = options.locale || pick(LOCALES_BY_OS[osChoice]);
  const language = locale.split('-')[0];
  const region = locale.split('-')[1] || 'US';

  // Pick fonts for OS (with random subset of non-marker fonts)
  const allFonts = osChoice === 'windows' ? WINDOWS_FONTS
    : osChoice === 'macos' ? MACOS_FONTS
    : LINUX_FONTS;
  // Keep first 4 as marker fonts (always included), randomize the rest
  const markerFonts = allFonts.slice(0, 4);
  const optionalFonts = randomSubset(allFonts.slice(4), 0.5, 0.9);
  const fonts = [...markerFonts, ...optionalFonts];

  // Generate random seeds for deterministic fingerprint perturbation
  const audioSeed = seed();
  const canvasSeed = seed();
  const fontSpacingSeed = seed();

  // Firefox UA string (matching Camoufox's Firefox 150 base)
  const ffVersion = '150.0';
  let userAgent;
  if (osChoice === 'windows') {
    userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${ffVersion}) Gecko/20100101 Firefox/${ffVersion}`;
  } else if (osChoice === 'macos') {
    userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${ffVersion}) Gecko/20100101 Firefox/${ffVersion}`;
  } else {
    userAgent = `Mozilla/5.0 (X11; Linux x86_64; rv:${ffVersion}) Gecko/20100101 Firefox/${ffVersion}`;
  }

  // Viewport (slightly smaller than screen to simulate window chrome)
  const viewport = {
    width: screen.width,
    height: screen.height - randomInt(60, 120), // taskbar/titlebar
  };

  // Build CAMOU_CONFIG — read by Camoufox's C++ engine at startup
  const config = {
    'navigator.userAgent': userAgent,
    'navigator.platform': preset.platform,
    'navigator.oscpu': preset.oscpu,
    'navigator.hardwareConcurrency': preset.hardwareConcurrency,
    'navigator.language': locale,
    'navigator.languages': [locale, language],
    'navigator.doNotTrack': 'unspecified',
    'navigator.cookieEnabled': true,
    'navigator.onLine': true,
    'navigator.globalPrivacyControl': false,
    'navigator.maxTouchPoints': 0,
    'navigator.pdfViewerEnabled': true,

    'screen.width': screen.width,
    'screen.height': screen.height,
    'screen.availWidth': screen.width,
    'screen.availHeight': screen.height - randomInt(30, 50), // taskbar
    'screen.availTop': 0,
    'screen.availLeft': 0,
    'screen.colorDepth': screen.colorDepth,
    'screen.pixelDepth': screen.colorDepth,

    'window.outerWidth': screen.width,
    'window.outerHeight': screen.height - randomInt(0, 40),
    'window.innerWidth': viewport.width,
    'window.innerHeight': viewport.height,
    'window.screenX': 0,
    'window.screenY': 0,
    'window.devicePixelRatio': screen.colorDepth >= 30 ? 2.0 : 1.0,

    'document.body.clientWidth': viewport.width,
    'document.body.clientHeight': viewport.height,

    'headers.User-Agent': userAgent,
    'headers.Accept-Language': `${locale},${language};q=0.9`,

    'webGl:vendor': webgl.vendor,
    'webGl:renderer': webgl.renderer,

    'audio:seed': audioSeed,
    'canvas:seed': canvasSeed,
    'fonts:spacing_seed': fontSpacingSeed,
    'fonts': fonts,

    'timezone': timezone,
    'locale:language': language,
    'locale:region': region,

    'humanize': true,
    'humanize:maxTime': 0.6,
    'humanize:minTime': 0.1,
  };

  // WebRTC IP (if provided, expose it; otherwise block WebRTC)
  if (options.webrtcIp) {
    config['webrtc:ipv4'] = options.webrtcIp;
  }

  // Build per-context init script (calls self-destructing C++ setters)
  const initScript = buildInitScript({
    fontSpacingSeed,
    audioSeed,
    canvasSeed,
    platform: preset.platform,
    oscpu: preset.oscpu,
    userAgent,
    hardwareConcurrency: preset.hardwareConcurrency,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    screenWidth: screen.width,
    screenHeight: screen.height,
    colorDepth: screen.colorDepth,
    timezone,
    fonts,
  });

  return {
    config,
    initScript,
    userAgent,
    viewport,
    os: osChoice,
    locale,
    timezone,
  };
}

/**
 * Build the init script that calls Camoufox's self-destructing window setters.
 * These setters are defined in Camoufox's C++ patches and remove themselves
 * after first call, making them undetectable to fingerprinting scripts.
 */
function buildInitScript(values) {
  const lines = [
    '(() => {',
    '  try {',
  ];

  const setters = [
    [`window.setFontSpacingSeed`, values.fontSpacingSeed],
    [`window.setAudioFingerprintSeed`, values.audioSeed],
    [`window.setCanvasSeed`, values.canvasSeed],
    [`window.setNavigatorPlatform`, values.platform],
    [`window.setNavigatorOscpu`, values.oscpu],
    [`window.setNavigatorUserAgent`, values.userAgent],
    [`window.setNavigatorHardwareConcurrency`, values.hardwareConcurrency],
    [`window.setWebGLVendor`, values.webglVendor],
    [`window.setWebGLRenderer`, values.webglRenderer],
    [`window.setScreenDimensions`, values.screenWidth, values.screenHeight],
    [`window.setScreenColorDepth`, values.colorDepth],
    [`window.setTimezone`, values.timezone],
    [`window.setFontList`, values.fonts.join(',')],
  ];

  for (const [fn, ...args] of setters) {
    const argsStr = args.map(a => typeof a === 'string' ? JSON.stringify(a) : a).join(', ');
    lines.push(`    if (typeof ${fn} === 'function') ${fn}(${argsStr});`);
  }

  lines.push('  } catch (e) {}');
  lines.push('})();');

  return lines.join('\n');
}

/**
 * Get a summary of the generated fingerprint (for logging).
 */
export function fingerprintSummary(fp) {
  return {
    os: fp.os,
    locale: fp.locale,
    timezone: fp.timezone,
    screen: `${fp.viewport.width}x${fp.viewport.height}`,
    ua: fp.userAgent.substring(0, 60) + '...',
  };
}
