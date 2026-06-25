#!/usr/bin/env python3
"""
Cloudflare API Token Batch Collector
=====================================
Processes multiple Cloudflare accounts via the Camoufox worker:
  1. Logs into each account
  2. Checks for existing API tokens
  3. If token exists → extracts name + status
  4. If no token → creates one (Zone DNS Edit, All zones)
  5. Saves results incrementally to JSON

Usage:
  python3 cf_batch_collector.py \
    --accounts accounts.json \
    --proxies proxies.txt \
    --output results.json \
    --worker http://localhost:3003 \
    --token-name dns_api_token \
    --captcha-key YOUR_2CAPTCHA_KEY \
    --delay 15

Accounts file (JSON):
  [
    {"email": "user1@example.com", "password": "pass1"},
    {"email": "user2@example.com", "password": "pass2"}
  ]

  Or CSV (email,password per line):
    user1@example.com,pass1
    user2@example.com,pass2

Proxies file (one per line):
  http://user:pass@host:port
"""

import argparse
import json
import random
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path


# ─────────────────────── Config ───────────────────────

WORKER_URL = "http://localhost:3003"
CAPTCHA_KEY = "655fa9f385d532059db94fb1b0f94adb"
TOKEN_NAME = "dns_api_token"
DELAY_MIN = 10
DELAY_MAX = 20

OS_CHOICES = ["windows"] * 75 + ["macos"] * 20 + ["linux"] * 5


# ─────────────────────── API Client ───────────────────────

def call_worker(endpoint, body=None, method="POST", timeout=600):
    """Call the Camoufox worker API."""
    url = f"{WORKER_URL}{endpoint}"
    if body:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
    else:
        req = urllib.request.Request(url, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body_text)
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}: {body_text[:200]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def close_session(session_id):
    """Close a browser session."""
    if not session_id:
        return
    try:
        call_worker(f"/sessions/{session_id}", method="DELETE", timeout=10)
    except Exception:
        pass


def get_step_result(results, action, index=0):
    """Get the Nth result for a given action type."""
    count = 0
    for r in results:
        if r.get("action") == action:
            if count == index:
                return r
            count += 1
    return None


def parse_eval(step):
    """Parse an evaluate step's JSON result."""
    if not step or not step.get("result", {}).get("value"):
        return None
    val = step["result"]["value"]
    if isinstance(val, str):
        try:
            return json.loads(val)
        except Exception:
            return val
    return val


# ─────────────────────── Steps Builder ───────────────────────

def build_login_steps(email, password):
    """Build the login + cookie extraction steps."""
    return [
        {"action": "goto", "params": {"url": "https://dash.cloudflare.com/login", "timeout": 90000}},
        {"action": "wait", "params": {"ms": 10000}},
        {"action": "solveTurnstile", "params": {"timeout": 120000}},
        {"action": "wait", "params": {"ms": 3000}},
        {"action": "click", "params": {"selector": "button:has-text('Accept All Cookies'), button:has-text('Reject All')", "timeout": 5000}},
        {"action": "wait", "params": {"ms": 1000}},
        {"action": "fill", "params": {"selector": "input[type=email]", "value": email}},
        {"action": "fill", "params": {"selector": "input[type=password]", "value": password}},
        {"action": "click", "params": {"selector": "button[type=submit]", "timeout": 10000}},
        {"action": "wait", "params": {"ms": 25000}},
        {"action": "evaluate", "params": {"script": "(() => { if (location.href.includes('/login')) throw new Error('Login failed - still on login page'); return JSON.stringify({loggedIn: true, url: location.href}); })()"}},
        {"action": "getCookies"},
    ]


def build_check_tokens_steps():
    """Build steps to navigate to API tokens and check existing ones."""
    return [
        {"action": "goto", "params": {"url": "https://dash.cloudflare.com/profile/api-tokens", "timeout": 60000}},
        {"action": "wait", "params": {"ms": 10000}},
        {"action": "evaluate", "params": {"script": """(() => {
          var tokens = [];
          document.querySelectorAll('table tbody tr').forEach(function(tr) {
            var tds = tr.querySelectorAll('td');
            if (tds.length >= 2 && !tr.querySelector('.emptyState, [class*=empty]')) {
              var name = '';
              var h5 = tr.querySelector('h5 span, h5');
              if (h5) name = h5.textContent.trim();
              var status = '';
              tds.forEach(function(td) { if (td.textContent.trim() === 'Active') status = 'Active'; });
              tokens.push({name: name, status: status});
            }
          });
          return JSON.stringify({tokenCount: tokens.length, tokens: tokens, isEmpty: tokens.length === 0});
        })()"""}},
    ]


def build_create_token_steps(token_name):
    """Build steps to create a new API token (Zone DNS Edit)."""
    return [
        {"action": "click", "params": {"selector": "a:has-text('Create Token'), button:has-text('Create Token')", "timeout": 15000}},
        {"action": "wait", "params": {"ms": 5000}},
        {"action": "click", "params": {"selector": "button:has-text('Get started'), a:has-text('Get started')", "timeout": 15000}},
        {"action": "wait", "params": {"ms": 5000}},

        # Token name
        {"action": "fill", "params": {"selector": "input[name=name]", "value": token_name}},
        {"action": "wait", "params": {"ms": 1000}},

        # Zone dropdown (Downshift)
        {"action": "click", "params": {"selector": "#cf-form-input1", "timeout": 5000}},
        {"action": "wait", "params": {"ms": 2000}},
        {"action": "evaluate", "params": {"script": "(() => { var items = document.querySelectorAll('#downshift-0-menu li'); for (var i = 0; i < items.length; i++) { if (items[i].textContent.trim().toLowerCase() === 'zone') { items[i].click(); return JSON.stringify({ok: true}); } } throw new Error('Zone not found'); })()"}},
        {"action": "wait", "params": {"ms": 2000}},

        # DNS permission (Downshift combobox — type to filter)
        {"action": "click", "params": {"selector": "#cf-form-input2", "timeout": 5000}},
        {"action": "wait", "params": {"ms": 1000}},
        {"action": "type", "params": {"selector": "#cf-form-input2", "text": "dns", "delay": 100}},
        {"action": "wait", "params": {"ms": 2000}},
        {"action": "evaluate", "params": {"script": "(() => { var items = document.querySelectorAll('#downshift-1-menu li'); for (var i = 0; i < items.length; i++) { if (items[i].textContent.trim().toLowerCase() === 'dns') { items[i].click(); return JSON.stringify({ok: true}); } } throw new Error('DNS not found'); })()"}},
        {"action": "wait", "params": {"ms": 2000}},

        # Edit permission (React-Select — mousedown on control)
        {"action": "evaluate", "params": {"script": """(() => {
          var placeholders = document.querySelectorAll('[class*=react-select__placeholder]');
          for (var i = 0; i < placeholders.length; i++) {
            if (placeholders[i].textContent.trim() === 'Select...') {
              var control = placeholders[i].closest('[class*=react-select__control]');
              if (control) {
                control.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
                return JSON.stringify({ok: true});
              }
            }
          }
          throw new Error('Select... placeholder not found');
        })()"""}},
        {"action": "wait", "params": {"ms": 2000}},
        {"action": "evaluate", "params": {"script": """(() => {
          var opts = document.querySelectorAll('[class*=react-select__option]');
          for (var i = 0; i < opts.length; i++) {
            if (opts[i].textContent.trim().toLowerCase() === 'edit') {
              opts[i].click();
              return JSON.stringify({ok: true});
            }
          }
          throw new Error('Edit option not found');
        })()"""}},
        {"action": "wait", "params": {"ms": 2000}},

        # Continue to summary + Create
        {"action": "click", "params": {"selector": "button:has-text('Continue to summary')", "timeout": 10000}},
        {"action": "wait", "params": {"ms": 5000}},
        {"action": "click", "params": {"selector": "button:has-text('Create Token')", "timeout": 10000}},
        {"action": "wait", "params": {"ms": 10000}},

        # Extract token
        {"action": "evaluate", "params": {"script": """(() => {
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
        })()"""}},
    ]


# ─────────────────────── Account Processor ───────────────────────

def process_account(email, password, proxy, os_choice, token_name, index, total):
    """Process a single Cloudflare account."""
    label = f"[{index + 1}/{total}]"
    result = {
        "email": email,
        "status": "unknown",
        "existing_tokens": [],
        "new_token": None,
        "proxy": proxy.get("server", "direct") if proxy else "direct",
        "os": os_choice,
        "error": None,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }

    session_id = None

    try:
        # ── Phase 1: Login ──
        print(f"{label} {email} — Logging in (os={os_choice}, proxy={result['proxy']})...")

        login_body = {
            "os": os_choice,
            "ttl": 600000,
            "captcha": {"provider": "2captcha", "apiKey": CAPTCHA_KEY},
            "stopOnError": True,
            "steps": build_login_steps(email, password),
        }
        if proxy:
            login_body["proxy"] = proxy

        login_resp = call_worker("/execute", login_body)
        session_id = login_resp.get("sessionId")

        # Check login success
        login_eval = parse_eval(get_step_result(login_resp.get("results", []), "evaluate", 0))
        if not login_eval or not login_eval.get("loggedIn"):
            error_msg = login_resp.get("error") or "Login did not redirect to dashboard"
            if isinstance(error_msg, dict):
                error_msg = error_msg.get("message", str(error_msg))
            result["status"] = "login_failed"
            result["error"] = str(error_msg)[:200]
            print(f"{label} {email} — LOGIN FAILED: {result['error'][:100]}")
            return result

        # Save cookies
        cookie_step = get_step_result(login_resp.get("results", []), "getCookies", 0)
        if cookie_step and cookie_step.get("result", {}).get("cookies"):
            result["cookies_count"] = len(cookie_step["result"]["cookies"])

        print(f"{label} {email} — Logged in OK, checking tokens...")

        # ── Phase 2: Check existing tokens ──
        check_resp = call_worker("/execute", {
            "sessionId": session_id,
            "ttl": 600000,
            "stopOnError": False,
            "steps": build_check_tokens_steps(),
        })

        tokens_info = parse_eval(get_step_result(check_resp.get("results", []), "evaluate", 0))

        if tokens_info and tokens_info.get("tokens"):
            result["existing_tokens"] = tokens_info["tokens"]
            print(f"{label} {email} — Found {len(tokens_info['tokens'])} existing token(s): "
                  + ", ".join(t.get("name", "?") for t in tokens_info["tokens"]))

            # If any token exists, record it and move on
            if tokens_info["tokenCount"] > 0:
                result["status"] = "existing_token_found"
                print(f"{label} {email} — DONE (existing token)")
                return result

        print(f"{label} {email} — No tokens found, creating new...")

        # ── Phase 3: Create token ──
        create_resp = call_worker("/execute", {
            "sessionId": session_id,
            "ttl": 600000,
            "stopOnError": True,
            "steps": build_create_token_steps(token_name),
        })

        # Find the last evaluate result (token extraction)
        all_evals = [r for r in (create_resp.get("results", []) or []) if r.get("action") == "evaluate"]
        token_data = parse_eval(all_evals[-1]) if all_evals else None

        if token_data and token_data.get("found") and token_data.get("token"):
            raw_token = token_data["token"]
            # Clean: extract just the token value (may include curl command)
            import re
            token_match = re.search(r"(cfut_[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{40,})", raw_token)
            clean_token = token_match.group(1) if token_match else raw_token

            result["status"] = "token_created"
            result["new_token"] = clean_token
            print(f"{label} {email} — TOKEN CREATED: {clean_token[:30]}...")
        else:
            result["status"] = "token_creation_failed"
            result["error"] = create_resp.get("error") or "Could not extract token value"
            if isinstance(result["error"], dict):
                result["error"] = str(result["error"])[:200]
            # Log which steps failed
            failed = [r for r in (create_resp.get("results", []) or []) if not r.get("ok")]
            if failed:
                result["error"] += f" | Failed steps: {', '.join(r['action'] for r in failed)}"
            print(f"{label} {email} — Token creation FAILED: {result['error'][:100]}")

        return result

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)[:200]
        print(f"{label} {email} — ERROR: {e}")
        return result

    finally:
        if session_id:
            close_session(session_id)


# ─────────────────────── File Helpers ───────────────────────

def load_accounts(path):
    """Load accounts from JSON array or CSV file."""
    text = Path(path).read_text().strip()

    # Try JSON first
    if text.startswith("["):
        return json.loads(text)

    # CSV fallback (email,password per line)
    accounts = []
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(",", 1)
        if len(parts) == 2:
            accounts.append({"email": parts[0].strip(), "password": parts[1].strip()})
    return accounts


def load_proxies(path):
    """Load proxies from text file (one per line)."""
    if not Path(path).exists():
        return []
    lines = Path(path).read_text().strip().split("\n")
    return [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]


def parse_proxy(proxy_str):
    """Parse proxy URL into worker format."""
    try:
        from urllib.parse import urlparse
        p = urlparse(proxy_str)
        return {
            "server": f"{p.scheme}://{p.hostname}:{p.port}",
            "username": p.username or None,
            "password": p.password or None,
        }
    except Exception:
        return None


def load_results(path):
    """Load existing results file (for resume)."""
    if not Path(path).exists():
        return []
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return []


def save_results(path, results):
    """Save results to JSON file."""
    Path(path).write_text(json.dumps(results, indent=2, ensure_ascii=False))


# ─────────────────────── Main ───────────────────────

def main():
    global WORKER_URL, CAPTCHA_KEY, TOKEN_NAME

    parser = argparse.ArgumentParser(description="Cloudflare API Token Batch Collector")
    parser.add_argument("--accounts", required=True, help="Path to accounts JSON/CSV file")
    parser.add_argument("--proxies", default="proxies.txt", help="Path to proxies file")
    parser.add_argument("--output", default="results.json", help="Output results file")
    parser.add_argument("--worker", default="http://localhost:3003", help="Camoufox worker URL")
    parser.add_argument("--captcha-key", default=CAPTCHA_KEY, help="2captcha API key")
    parser.add_argument("--token-name", default=TOKEN_NAME, help="Name for created tokens")
    parser.add_argument("--delay", type=int, default=15, help="Seconds between accounts (base)")
    parser.add_argument("--start", type=int, default=0, help="Start from account index N")
    parser.add_argument("--limit", type=int, default=0, help="Process only N accounts (0=all)")
    args = parser.parse_args()

    WORKER_URL = args.worker
    CAPTCHA_KEY = args.captcha_key
    TOKEN_NAME = args.token_name

    print("=" * 60)
    print("Cloudflare API Token Batch Collector")
    print("=" * 60)
    print(f"  Worker:     {WORKER_URL}")
    print(f"  Accounts:   {args.accounts}")
    print(f"  Proxies:    {args.proxies}")
    print(f"  Output:     {args.output}")
    print(f"  Token name: {TOKEN_NAME}")
    print(f"  Delay:      {args.delay}s (base)")
    print()

    # Health check
    health = call_worker("/health", method="GET", timeout=10)
    if not health.get("ok"):
        print(f"ERROR: Worker not healthy at {WORKER_URL}: {health}")
        sys.exit(1)
    print(f"Worker: {json.dumps(health)}")

    # Load data
    accounts = load_accounts(args.accounts)
    proxies = load_proxies(args.proxies)
    results = load_results(args.output)
    processed_emails = {r["email"] for r in results}

    print(f"Accounts: {len(accounts)}")
    print(f"Proxies:  {len(proxies)}")
    print(f"Already processed: {len(processed_emails)}")
    print()

    if not proxies:
        print("WARNING: No proxies loaded — running without proxy")

    # Apply start/limit
    work = accounts[args.start:]
    if args.limit:
        work = work[:args.limit]

    success = 0
    failed = 0

    for i, account in enumerate(work):
        email = account["email"]
        password = account["password"]

        # Skip already processed
        if email in processed_emails:
            print(f"\n[{i + 1}/{len(work)}] {email} — SKIPPED (already done)")
            continue

        # Random proxy + OS
        proxy = parse_proxy(random.choice(proxies)) if proxies else None
        os_choice = random.choice(OS_CHOICES)

        # Process
        result = process_account(email, password, proxy, os_choice, TOKEN_NAME, i, len(work))
        results.append(result)

        # Save after each account
        save_results(args.output, results)

        if result["status"] in ("existing_token_found", "token_created"):
            success += 1
        else:
            failed += 1

        # Progress
        total_done = len([r for r in results if r["email"] in {a["email"] for a in work}])
        print(f"  → Saved ({total_done}/{len(work)}) | Success: {success} | Failed: {failed}")

        # Delay between accounts (with jitter)
        if i < len(work) - 1:
            delay = args.delay + random.randint(0, 10)
            print(f"  → Waiting {delay}s...")
            time.sleep(delay)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    all_statuses = {}
    for r in results:
        s = r.get("status", "unknown")
        all_statuses[s] = all_statuses.get(s, 0) + 1

    print(f"Total processed: {len(results)}")
    for status, count in sorted(all_statuses.items()):
        print(f"  {status}: {count}")
    print(f"\nResults saved to: {args.output}")

    # Print tokens found
    tokens = [r for r in results if r.get("new_token")]
    existing = [r for r in results if r["status"] == "existing_token_found"]
    if tokens:
        print(f"\nNew tokens created ({len(tokens)}):")
        for r in tokens:
            print(f"  {r['email']}: {r['new_token'][:40]}...")
    if existing:
        print(f"\nAccounts with existing tokens ({len(existing)}):")
        for r in existing:
            names = ", ".join(t.get("name", "?") for t in r.get("existing_tokens", []))
            print(f"  {r['email']}: {names}")


if __name__ == "__main__":
    main()
