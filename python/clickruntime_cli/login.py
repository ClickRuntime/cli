"""Sign-in: OAuth loopback with PKCE, falling back to the device authorization grant (RFC 8628)."""
import base64
import hashlib
import html
import http.server
import json
import os
import secrets
import threading
import time
import urllib.parse
import webbrowser
from typing import Optional

from .client import (CLIENT_ID, SCOPES, CliError, Exit, api_url, auth_url, oauth_post, pending_path,
                     profile_from_token, save_profile, write_json_private)

LOOPBACK_TIMEOUT_S = float(os.environ.get("CLICKRUNTIME_LOOPBACK_TIMEOUT_MS", "300000")) / 1000

# Pages shown in the browser after the loopback redirect. Same tokens as the OAuth pages
# (platform/backend/internal/oauth/pages.go, "magenta graphite"), light and dark.
PAGE_OK = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Signed in · ClickRuntime</title><style>:root{--paper:#F7F7F8;--surface:#FFFFFF;--ink:#121216;--muted:#5D5D68;--rule:#DCDCE2;--signal:#B8226C;--signal-ink:#FFFFFF;--live:#166534;--live-tint:#E2F3E9;--danger:#C33A2F;--danger-tint:#FBE7E5;color-scheme:light dark}@media (prefers-color-scheme:dark){:root{--paper:#0E0E11;--surface:#16161A;--ink:#EFEFF3;--muted:#A0A0AD;--rule:#2A2A31;--signal:#FF4FA3;--signal-ink:#0E0E11;--live:#4FC483;--live-tint:#10291B;--danger:#F2786D;--danger-tint:#341815}}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:30rem;margin:0 auto;padding:3.5rem 1.25rem 3rem}.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;letter-spacing:-.01em;margin-bottom:2rem}.brand svg{width:1.5rem;height:1.5rem}.card{background:var(--surface);border:1px solid var(--rule);border-radius:.375rem;padding:1.75rem}.icon{width:2.5rem;height:2.5rem;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:1rem;background:var(--live-tint);color:var(--live)}.icon.bad{background:var(--danger-tint);color:var(--danger)}.icon svg{width:1.25rem;height:1.25rem}h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 .75rem;font-weight:650}p{margin:0 0 1rem}.lede{color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--paper);border:1px solid var(--rule);border-radius:.25rem;padding:.05rem .35rem}.btn{display:flex;justify-content:center;width:100%;font-weight:600;padding:.8rem 1rem;border-radius:.25rem;border:1px solid var(--rule);color:var(--ink);text-decoration:none;margin-top:1.25rem}.btn:hover{border-color:var(--signal)}</style></head><body><main><div class="brand"><svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#B8226C"/><path transform="translate(15.33 45.67) scale(.82)" fill="#FFFFFF" d="M179.56 49.3C176.635 49.3 173.807 49.9825 171.24 51.12C139.292 65.5175 163.31 157.688 194.12 233.38C197.142 201.985 223.825 177.22 256 177.22C269.487 177.22 281.935 181.835 292.14 189.18C292.205 189.213 292.335 189.148 292.4 189.18C260.257 124.18 211.865 49.3 179.56 49.3ZM292.4 189.18C307.902 200.458 318.14 218.755 318.14 239.36C318.14 264.515 303.027 286.29 281.48 296.04C298.217 297.113 314.695 297.86 330.36 297.86C368.71 297.86 458.247 294.058 461.66 260.16C465.17 225.353 373.325 200.36 292.4 189.18ZM281.48 296.04C281.317 296.105 281.122 295.975 280.96 296.04C273.29 299.453 264.905 301.5 256 301.5C221.777 301.5 193.86 273.583 193.86 239.36C193.86 237.313 194.185 235.363 194.38 233.38C149.075 301.37 106.695 386.878 135.1 407.32C138.642 409.855 142.965 411.22 147.84 411.22C180.6 411.22 239.912 349.503 281.48 296.04ZM256 193.6C230.78 193.6 210.24 214.14 210.24 239.36C210.24 264.58 230.78 285.12 256 285.12C281.22 285.12 301.76 264.58 301.76 239.36C301.76 214.14 281.22 193.6 256 193.6ZM256 218.56C267.472 218.56 276.8 227.855 276.8 239.36C276.8 250.865 267.472 260.16 256 260.16C244.495 260.16 235.2 250.865 235.2 239.36C235.2 227.855 244.495 218.56 256 218.56ZM285.12 319.44C269.097 339.298 246.607 365.525 222.72 387.3L217 454.9C216.805 457.208 217.487 459.418 219.08 461.14C220.672 462.863 222.98 464 225.32 464H286.68C288.987 464 291.1 462.83 292.66 461.14C294.22 459.45 295.162 457.208 295 454.9L285.12 319.44Z"/></svg>ClickRuntime</div><div class="card"><div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><h1>You’re signed in</h1><p class="lede">The ClickRuntime CLI is connected to your workspace. Close this tab and go back to your agent.</p><a class="btn" href="{{DASHBOARD}}">Open the ClickRuntime dashboard</a></div></main></body></html>'
PAGE_FAILED = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Sign-in not completed · ClickRuntime</title><style>:root{--paper:#F7F7F8;--surface:#FFFFFF;--ink:#121216;--muted:#5D5D68;--rule:#DCDCE2;--signal:#B8226C;--signal-ink:#FFFFFF;--live:#166534;--live-tint:#E2F3E9;--danger:#C33A2F;--danger-tint:#FBE7E5;color-scheme:light dark}@media (prefers-color-scheme:dark){:root{--paper:#0E0E11;--surface:#16161A;--ink:#EFEFF3;--muted:#A0A0AD;--rule:#2A2A31;--signal:#FF4FA3;--signal-ink:#0E0E11;--live:#4FC483;--live-tint:#10291B;--danger:#F2786D;--danger-tint:#341815}}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:30rem;margin:0 auto;padding:3.5rem 1.25rem 3rem}.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;letter-spacing:-.01em;margin-bottom:2rem}.brand svg{width:1.5rem;height:1.5rem}.card{background:var(--surface);border:1px solid var(--rule);border-radius:.375rem;padding:1.75rem}.icon{width:2.5rem;height:2.5rem;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:1rem;background:var(--live-tint);color:var(--live)}.icon.bad{background:var(--danger-tint);color:var(--danger)}.icon svg{width:1.25rem;height:1.25rem}h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 .75rem;font-weight:650}p{margin:0 0 1rem}.lede{color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--paper);border:1px solid var(--rule);border-radius:.25rem;padding:.05rem .35rem}.btn{display:flex;justify-content:center;width:100%;font-weight:600;padding:.8rem 1rem;border-radius:.25rem;border:1px solid var(--rule);color:var(--ink);text-decoration:none;margin-top:1.25rem}.btn:hover{border-color:var(--signal)}</style></head><body><main><div class="brand"><svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#B8226C"/><path transform="translate(15.33 45.67) scale(.82)" fill="#FFFFFF" d="M179.56 49.3C176.635 49.3 173.807 49.9825 171.24 51.12C139.292 65.5175 163.31 157.688 194.12 233.38C197.142 201.985 223.825 177.22 256 177.22C269.487 177.22 281.935 181.835 292.14 189.18C292.205 189.213 292.335 189.148 292.4 189.18C260.257 124.18 211.865 49.3 179.56 49.3ZM292.4 189.18C307.902 200.458 318.14 218.755 318.14 239.36C318.14 264.515 303.027 286.29 281.48 296.04C298.217 297.113 314.695 297.86 330.36 297.86C368.71 297.86 458.247 294.058 461.66 260.16C465.17 225.353 373.325 200.36 292.4 189.18ZM281.48 296.04C281.317 296.105 281.122 295.975 280.96 296.04C273.29 299.453 264.905 301.5 256 301.5C221.777 301.5 193.86 273.583 193.86 239.36C193.86 237.313 194.185 235.363 194.38 233.38C149.075 301.37 106.695 386.878 135.1 407.32C138.642 409.855 142.965 411.22 147.84 411.22C180.6 411.22 239.912 349.503 281.48 296.04ZM256 193.6C230.78 193.6 210.24 214.14 210.24 239.36C210.24 264.58 230.78 285.12 256 285.12C281.22 285.12 301.76 264.58 301.76 239.36C301.76 214.14 281.22 193.6 256 193.6ZM256 218.56C267.472 218.56 276.8 227.855 276.8 239.36C276.8 250.865 267.472 260.16 256 260.16C244.495 260.16 235.2 250.865 235.2 239.36C235.2 227.855 244.495 218.56 256 218.56ZM285.12 319.44C269.097 339.298 246.607 365.525 222.72 387.3L217 454.9C216.805 457.208 217.487 459.418 219.08 461.14C220.672 462.863 222.98 464 225.32 464H286.68C288.987 464 291.1 462.83 292.66 461.14C294.22 459.45 295.162 457.208 295 454.9L285.12 319.44Z"/></svg>ClickRuntime</div><div class="card"><div class="icon bad"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></div><h1>Sign-in was not completed</h1><p class="lede">{{REASON}} Go back to your agent and run <code>clickruntime login</code> again.</p></div></main></body></html>'


def _done_page() -> bytes:
    return PAGE_OK.replace("{{DASHBOARD}}", html.escape(auth_url() + "/home")).encode("utf-8")


def _failed_page(reason: str) -> bytes:
    return PAGE_FAILED.replace("{{REASON}}", html.escape(reason)).encode("utf-8")


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


class _Loopback:
    """A browser sign-in waiting on its loopback callback. It keeps listening until close(), also
    while the CLI offers a device code, so Allow in a consent page left open still works (the server
    expires the page once the CLI stops waiting)."""

    def __init__(self, profile: str, progress):
        self.profile = profile
        self.verifier = _b64url(secrets.token_bytes(32))
        challenge = _b64url(hashlib.sha256(self.verifier.encode()).digest())
        state = _b64url(secrets.token_bytes(16))
        # done is set when the callback arrives; code is "" when the person cancelled in the browser.
        self.done = threading.Event()
        self.code = None
        lb = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                if u.path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                q = urllib.parse.parse_qs(u.query)
                if q.get("state", [""])[0] != state:
                    self.send_response(400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(_failed_page("This sign-in link does not match the one the CLI started."))
                    return
                code = q.get("code", [""])[0]
                self.send_response(200 if code else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(_done_page() if code else _failed_page("ClickRuntime did not approve the sign-in."))
                if lb.code is None:
                    lb.code = code
                    lb.done.set()

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.redirect = "http://127.0.0.1:%d/callback" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        q = urllib.parse.urlencode({
            "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": self.redirect, "scope": SCOPES, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256", "resource": api_url(),
        })
        url = "%s/oauth/authorize?%s" % (auth_url(), q)
        progress("Opening the browser to sign in. If it does not open, visit:\n" + url)
        try:
            self.opened = bool(webbrowser.open(url))
        except Exception:
            self.opened = False

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def finish(self):
        """Exchanges the callback's code for tokens and saves the sign-in."""
        status, body = oauth_post("/oauth/token", {
            "grant_type": "authorization_code", "code": self.code, "redirect_uri": self.redirect, "client_id": CLIENT_ID,
            "code_verifier": self.verifier, "resource": api_url(),
        })
        if status != 200 or not body.get("access_token"):
            raise CliError(body.get("error") or "login_failed", body.get("error_description") or "Sign-in failed. Run clickruntime login again.")
        save_profile(self.profile, profile_from_token(body))


def _denied():
    return CliError("access_denied", "The sign-in was cancelled in the browser.", Exit.CANCELLED)


def _browser_login(profile: str, announce, progress) -> str:
    """Browser sign-in with a device code as the fallback. After LOOPBACK_TIMEOUT_S without a callback
    the CLI also offers a code, but keeps waiting for the browser: whichever the person finishes
    first signs in, and the other is dropped."""
    lb = _Loopback(profile, progress)
    try:
        if lb.opened and lb.done.wait(LOOPBACK_TIMEOUT_S):
            if not lb.code:
                raise _denied()
            lb.finish()
            return "signed_in"
        if lb.opened:
            progress("Still waiting for the browser. You can also sign in with a code instead:")
        p = _start_device(profile)
        announce(device_next(p), p["user_code"])
        _poll_device(profile, p, stop=lb.done)
        if lb.done.is_set():
            _remove_pending(profile)
            if not lb.code:
                raise _denied()
            lb.finish()
        return "signed_in"
    finally:
        lb.close()


def device_next(p):
    return {
        "action": "open_link",
        "url": p["verification_uri"],
        "say": "Open %s and enter %s to connect ClickRuntime." % (p["verification_uri"], p["user_code"]),
    }


def _start_device(profile: str):
    status, body = oauth_post("/oauth/device_authorization", {"client_id": CLIENT_ID, "scope": SCOPES, "resource": api_url()})
    if status != 200 or not body.get("device_code"):
        raise CliError(body.get("error") or "login_failed", body.get("error_description") or "Could not start the device sign-in.")
    p = {
        "device_code": body["device_code"],
        "user_code": body["user_code"],
        # Never a link with the code in it: the person types the code on the page.
        "verification_uri": (body.get("verification_uri") or "").split("?")[0],
        "interval": int(body.get("interval") or 5),
        "expires_at": int(time.time()) + int(body.get("expires_in") or 600),
    }
    write_json_private(pending_path(profile), p)
    return p


def _remove_pending(profile: str):
    try:
        os.remove(pending_path(profile))
    except OSError:
        pass


def _poll_device(profile: str, p, stop: Optional[threading.Event] = None) -> None:
    """Polls until the code is approved. Returns early, without signing in, once stop is set (the
    browser sign-in finished first)."""
    interval = p["interval"]
    while True:
        if stop is not None and stop.is_set():
            return
        if time.time() > p["expires_at"]:
            _remove_pending(profile)
            raise CliError("expired_token", "The sign-in code expired. Run clickruntime login again.", Exit.CANCELLED)
        status, body = oauth_post("/oauth/token", {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": p["device_code"], "client_id": CLIENT_ID,
        })
        if stop is not None and stop.is_set():
            return
        if status == 200 and body.get("access_token"):
            save_profile(profile, profile_from_token(body))
            _remove_pending(profile)
            return
        err = body.get("error")
        if err == "authorization_pending":
            pass
        elif err == "slow_down":
            interval += 5
        elif err == "access_denied":
            _remove_pending(profile)
            raise CliError("access_denied", "The sign-in was denied.", Exit.CANCELLED)
        elif err == "expired_token":
            _remove_pending(profile)
            raise CliError("expired_token", "The sign-in code expired. Run clickruntime login again.", Exit.CANCELLED)
        else:
            _remove_pending(profile)
            raise CliError(err or "login_failed", body.get("error_description") or "Sign-in failed. Run clickruntime login again.")
        if stop is not None:
            stop.wait(interval)
        else:
            time.sleep(interval)


def login(profile: str, device: bool, no_browser: bool, no_wait: bool, continue_pending: bool, announce, progress) -> str:
    if continue_pending:
        if not os.path.exists(pending_path(profile)):
            raise CliError("usage", "There is no pending sign-in. Run clickruntime login.", Exit.USAGE)
        with open(pending_path(profile), encoding="utf-8") as f:
            p = json.load(f)
        _poll_device(profile, p)
        return "signed_in"
    if not device and not no_browser and not no_wait:
        return _browser_login(profile, announce, progress)
    p = _start_device(profile)
    announce(device_next(p), p["user_code"])
    if no_wait:
        return "waiting"
    _poll_device(profile, p)
    return "signed_in"
