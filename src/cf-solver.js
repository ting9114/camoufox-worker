/**
 * Cloudflare Turnstile Solver
 * ===========================
 * Detects and solves Cloudflare Turnstile challenges using 2captcha API.
 * Works directly in Playwright — no Python/cloudscraper needed.
 *
 * Supported CAPTCHA providers:
 *   - 2captcha (default)
 *
 * Usage as a browser-worker action:
 *   { "action": "solveTurnstile", "params": { "timeout": 120000 } }
 *
 * Requires `captcha` config in the /execute request body:
 *   { "captcha": { "provider": "2captcha", "apiKey": "YOUR_KEY" } }
 */

const POLL_INTERVAL = 5000; // 5 seconds between 2captcha polls
const MAX_POLL_TIME = 120000; // 2 minutes max wait

/**
 * Detect Turnstile widget on the page and extract sitekey.
 */
async function detectTurnstile(page) {
  return page.evaluate(() => {
    // Method 1: Look for cf-turnstile div with data-sitekey
    const turnstileDiv = document.querySelector('[class*="cf-turnstile"], [data-sitekey]');
    if (turnstileDiv) {
      const sitekey = turnstileDiv.getAttribute('data-sitekey');
      if (sitekey) return { found: true, sitekey, method: 'data-sitekey' };
    }

    // Method 2: Look for turnstile iframe
    const iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
    for (const iframe of iframes) {
      const src = iframe.src || '';
      const match = src.match(/[?&]k=([^&]+)/);
      if (match) return { found: true, sitekey: match[1], method: 'iframe' };
    }

    // Method 3: Look for turnstile script tag
    const scripts = document.querySelectorAll('script[src*="challenges.cloudflare.com"]');
    for (const script of scripts) {
      const src = script.src || '';
      const match = src.match(/render=([^&]+)/);
      if (match) return { found: true, sitekey: match[1], method: 'script' };
    }

    // Method 4: Search in page source for turnstile render calls
    const html = document.documentElement.innerHTML;
    const renderMatch = html.match(/turnstile\.render\([^,]*,\s*\{[^}]*sitekey:\s*['"]([^'"]+)['"]/);
    if (renderMatch) return { found: true, sitekey: renderMatch[1], method: 'render-call' };

    // Method 5: Look for hidden cf-turnstile-response input
    const hiddenInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (hiddenInput) {
      // Turnstile is present but we need the sitekey from elsewhere
      // Try to find it in any data attribute or script
      const allElements = document.querySelectorAll('[data-sitekey]');
      for (const el of allElements) {
        const sk = el.getAttribute('data-sitekey');
        if (sk) return { found: true, sitekey: sk, method: 'hidden-input+data-attr' };
      }
      return { found: true, sitekey: null, method: 'hidden-input-only' };
    }

    // Check if page text indicates a challenge
    const bodyText = document.body ? document.body.innerText : '';
    const isChallenged = bodyText.includes('Verify you are human') ||
                         bodyText.includes('security verification') ||
                         bodyText.includes('Checking your browser');
    if (isChallenged) {
      return { found: true, sitekey: null, method: 'text-detection' };
    }

    return { found: false };
  });
}

/**
 * Submit Turnstile challenge to 2captcha and wait for solution.
 */
async function solve2captcha(apiKey, sitekey, pageUrl, proxyConfig) {
  // Step 1: Submit the task
  const submitParams = new URLSearchParams({
    key: apiKey,
    method: 'turnstile',
    sitekey: sitekey,
    pageurl: pageUrl,
    json: '1'
  });

  // Add proxy info if available (helps 2captcha solve from same IP)
  if (proxyConfig && proxyConfig.server) {
    const proxyUrl = new URL(proxyConfig.server);
    submitParams.set('proxy', `${proxyConfig.username}:${proxyConfig.password}@${proxyUrl.hostname}:${proxyUrl.port}`);
    submitParams.set('proxytype', 'HTTP');
  }

  const submitUrl = `https://2captcha.com/in.php?${submitParams}`;
  console.log(`[cf-solver] Submitting Turnstile to 2captcha (sitekey: ${sitekey.substring(0, 20)}...)`);

  const submitResp = await fetch(submitUrl);
  const submitData = await submitResp.json();

  if (submitData.status !== 1) {
    throw new Error(`2captcha submit failed: ${submitData.request || JSON.stringify(submitData)}`);
  }

  const requestId = submitData.request;
  console.log(`[cf-solver] 2captcha task submitted, ID: ${requestId}`);

  // Step 2: Poll for result
  const startTime = Date.now();
  await sleep(15000); // Initial wait — 2captcha needs at least 15s

  while (Date.now() - startTime < MAX_POLL_TIME) {
    const pollUrl = `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`;
    const pollResp = await fetch(pollUrl);
    const pollData = await pollResp.json();

    if (pollData.status === 1) {
      console.log(`[cf-solver] 2captcha solved in ${Math.round((Date.now() - startTime) / 1000)}s`);
      return pollData.request; // The solution token
    }

    if (pollData.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha error: ${pollData.request}`);
    }

    console.log(`[cf-solver] Waiting for solution... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    await sleep(POLL_INTERVAL);
  }

  throw new Error(`2captcha timeout after ${MAX_POLL_TIME / 1000}s`);
}

/**
 * Inject the solved Turnstile token into the page and submit.
 */
async function injectSolution(page, token) {
  return page.evaluate((solvedToken) => {
    // Set the hidden input value
    var responseInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (responseInput) {
      responseInput.value = solvedToken;
    }

    // Try to find and call the Turnstile callback
    // Method 1: Global turnstile object
    if (typeof window.turnstile !== 'undefined' && window.turnstile) {
      // Look for callback in turnstile widgets
      try {
        var widgets = document.querySelectorAll('[class*="cf-turnstile"], [data-sitekey]');
        for (var i = 0; i < widgets.length; i++) {
          var callback = widgets[i].getAttribute('data-callback');
          if (callback && typeof window[callback] === 'function') {
            window[callback](solvedToken);
            return { injected: true, method: 'data-callback' };
          }
        }
      } catch (e) {}
    }

    // Method 2: Look for the challenge form and submit it
    var forms = document.querySelectorAll('form');
    for (var j = 0; j < forms.length; j++) {
      var input = forms[j].querySelector('input[name="cf-turnstile-response"]');
      if (input) {
        input.value = solvedToken;
        forms[j].submit();
        return { injected: true, method: 'form-submit' };
      }
    }

    // Method 3: Try __cf_chl_f_tk hidden form (Cloudflare challenge page)
    var cfForm = document.querySelector('#challenge-form, form[action*="__cf_chl"]');
    if (cfForm) {
      if (responseInput) responseInput.value = solvedToken;
      cfForm.submit();
      return { injected: true, method: 'challenge-form' };
    }

    // Method 4: Dispatch a custom event that Cloudflare might listen for
    if (responseInput) {
      responseInput.dispatchEvent(new Event('input', { bubbles: true }));
      responseInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { injected: true, method: 'event-dispatch' };
    }

    return { injected: false, method: 'none' };
  }, token);
}

/**
 * Main solver function — called as a browser-worker action.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {object} captchaConfig - { provider: '2captcha', apiKey: '...' }
 * @param {object} proxyConfig - { server, username, password }
 * @param {object} params - action params { timeout, waitAfter }
 * @returns {object} result
 */
export async function solveTurnstile(page, captchaConfig, proxyConfig, params = {}) {
  const timeout = params.timeout || 120000;
  const waitAfter = params.waitAfter || 5000;

  if (!captchaConfig || !captchaConfig.apiKey) {
    throw new Error('captcha.apiKey is required for solveTurnstile action');
  }

  const provider = captchaConfig.provider || '2captcha';
  if (provider !== '2captcha') {
    throw new Error(`Unsupported CAPTCHA provider: ${provider}. Only "2captcha" is supported.`);
  }

  // Step 1: Detect Turnstile
  const detection = await detectTurnstile(page);
  console.log(`[cf-solver] Detection result:`, detection);

  if (!detection.found) {
    return { solved: false, reason: 'no_turnstile_detected', url: page.url() };
  }

  if (!detection.sitekey) {
    // Try to extract sitekey from page source as fallback
    const content = await page.content();
    const sitekeyMatch = content.match(/sitekey['":\s]+['"]?(0x[A-Za-z0-9_-]+)/);
    if (sitekeyMatch) {
      detection.sitekey = sitekeyMatch[1];
      console.log(`[cf-solver] Found sitekey via content scan: ${detection.sitekey}`);
    } else {
      return {
        solved: false,
        reason: 'turnstile_detected_but_no_sitekey',
        detection,
        url: page.url()
      };
    }
  }

  // Step 2: Solve via 2captcha
  const pageUrl = page.url();
  const token = await solve2captcha(captchaConfig.apiKey, detection.sitekey, pageUrl, proxyConfig);

  // Step 3: Inject solution
  const injection = await injectSolution(page, token);
  console.log(`[cf-solver] Injection result:`, injection);

  // Step 4: Wait for page to process the solution
  await page.waitForTimeout(waitAfter);

  // Step 5: Check if we got cf_clearance
  const context = page.context();
  const cookies = await context.cookies();
  const cfClearance = cookies.find(c => c.name === 'cf_clearance');

  return {
    solved: true,
    detection,
    injection,
    cfClearance: cfClearance ? cfClearance.value : null,
    url: page.url(),
    cookieCount: cookies.length
  };
}

/**
 * Check if the current page has a Turnstile challenge (non-solving detection).
 */
export async function hasTurnstile(page) {
  return detectTurnstile(page);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
