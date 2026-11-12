"""HTTP client over the generated operation table, the credentials file and token refresh.

Behaviour: ../../SPEC.md (shared with the Node CLI, checked by conformance/).
"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple

from .generated import OPERATIONS

CLIENT_ID = "clickruntime-cli"
SCOPES = "openid email workspace:read automations:draft automations:control offline_access"
VERSION = "0.1.0"


class Exit:
    OK = 0
    ERROR = 1
    USAGE = 2
    SIGNED_OUT = 3
    WAITING = 4
    RATE_LIMITED = 5
    CANCELLED = 6


class CliError(Exception):
    """A failure that ends the command: printed as {error, message, next?, details?}."""

    def __init__(self, code: str, message: str, exit: int = Exit.ERROR, next: Optional[dict] = None, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit = exit
        self.next = next
        self.details = details

    def to_json(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"error": self.code, "message": self.message}
        if self.next:
            out["next"] = self.next
        if self.details:
            out["details"] = self.details
        return out


SIGN_IN_NEXT = {
    "action": "login",
    "say": "I need you to sign in to ClickRuntime: I will run clickruntime login and give you a link.",
}


def api_url() -> str:
    return _checked_url("CLICKRUNTIME_API_URL", os.environ.get("CLICKRUNTIME_API_URL") or "https://clickruntime.com/api/v1")


def auth_url() -> str:
    return _checked_url("CLICKRUNTIME_AUTH_URL", os.environ.get("CLICKRUNTIME_AUTH_URL") or "https://clickruntime.com")


_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _checked_url(name: str, raw: str) -> str:
    """A base URL with no trailing slash. Tokens go only over https, or plain http to this machine."""
    v = raw.strip().rstrip("/")
    u = urllib.parse.urlsplit(v)
    if not u.scheme or not u.hostname:
        raise CliError("usage", "%s is not a URL: %s" % (name, v), Exit.USAGE)
    if u.scheme != "https" and not (u.scheme == "http" and u.hostname in _LOOPBACK_HOSTS):
        raise CliError("usage", "%s must use https (plain http only for localhost): %s" % (name, v), Exit.USAGE)
    return v


def profile_hosts(p: Dict[str, Any]) -> Dict[str, str]:
    """The hosts a saved sign-in may be sent to: the ones it was issued by. If CLICKRUNTIME_API_URL or
    CLICKRUNTIME_AUTH_URL now names another host, the token is not sent there (it could be a value a
    repository's .env planted); the person signs in again for that host instead."""
    want_api, want_auth = api_url(), auth_url()
    api = p.get("api_url") or want_api
    auth = p.get("auth_url") or want_auth
    if api != want_api or auth != want_auth:
        have, other = (api, want_api) if api != want_api else (auth, want_auth)
        raise CliError(
            "other_host",
            "This sign-in is for %s, but the CLI is set to use %s. Run clickruntime login to sign in there, "
            "or unset CLICKRUNTIME_API_URL and CLICKRUNTIME_AUTH_URL." % (have, other),
            Exit.SIGNED_OUT, SIGN_IN_NEXT)
    return {"api": api, "auth": auth}


def config_dir() -> str:
    if os.environ.get("CLICKRUNTIME_CONFIG_DIR"):
        return os.environ["CLICKRUNTIME_CONFIG_DIR"]
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        return os.path.join(os.environ["APPDATA"], "clickruntime")
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "clickruntime")


def _credentials_path() -> str:
    return os.path.join(config_dir(), "credentials.json")


def pending_path(profile: str) -> str:
    return os.path.join(config_dir(), "pending-%s.json" % profile)


def read_credentials() -> Dict[str, Any]:
    try:
        with open(_credentials_path(), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("profiles"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"profiles": {}}


def write_json_private(path: str, data: Any) -> None:
    os.makedirs(config_dir(), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def save_profile(name: str, profile: Dict[str, Any]) -> None:
    creds = read_credentials()
    creds["profiles"][name] = profile
    write_json_private(_credentials_path(), creds)


def delete_profile(name: str) -> None:
    creds = read_credentials()
    creds["profiles"].pop(name, None)
    if not creds["profiles"]:
        try:
            os.remove(_credentials_path())
        except OSError:
            pass
    else:
        write_json_private(_credentials_path(), creds)


def _request(method: str, url: str, headers: Dict[str, str], data: Optional[bytes]):
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except (urllib.error.URLError, OSError) as e:
        host = url.split("/")[2] if "://" in url else url
        raise CliError("network_error", "Could not reach %s: %s" % (host, getattr(e, "reason", e)))


def oauth_post(path: str, form: Dict[str, str], base: Optional[str] = None):
    status, _, raw = _request(
        "POST",
        (base or auth_url()) + path,
        {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        urllib.parse.urlencode(form).encode(),
    )
    try:
        body = json.loads(raw.decode() or "{}")
    except ValueError:
        body = {}
    return status, body


def profile_from_token(body: Dict[str, Any], prev: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token") or (prev or {}).get("refresh_token"),
        "expires_at": int(time.time()) + int(body.get("expires_in") or 3600),
        "auth_url": (prev or {}).get("auth_url") or auth_url(),
        "api_url": (prev or {}).get("api_url") or api_url(),
    }


_LOCK_WAIT_S = 15.0
_LOCK_STALE_S = 30.0


def _fresh(p: Optional[Dict[str, Any]]) -> bool:
    return bool(p and p.get("access_token") and p.get("expires_at") and p["expires_at"] - 60 > time.time())


class _CredentialsLock:
    """Holds credentials.lock so parallel CLI processes refresh one at a time. Two processes
    sending the same refresh token look like token theft to the server, which then ends the
    sign-in. A lock older than _LOCK_STALE_S is from a process that died and is taken over."""

    def __enter__(self):
        os.makedirs(config_dir(), mode=0o700, exist_ok=True)
        self.path = os.path.join(config_dir(), "credentials.lock")
        deadline = time.time() + _LOCK_WAIT_S
        while True:
            try:
                os.close(os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
                return self
            except FileExistsError:
                try:
                    if time.time() - os.stat(self.path).st_mtime > _LOCK_STALE_S:
                        os.remove(self.path)
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > deadline:
                    raise CliError("busy", "Another clickruntime command is refreshing the sign-in. Try again in a few seconds.")
                time.sleep(0.1 + random.random() * 0.15)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass
        return False


def access_token(profile: str) -> Tuple[str, str]:
    """The access token for profile and the API base it may be sent to, refreshed when about to expire."""
    if os.environ.get("CLICKRUNTIME_TOKEN"):
        return os.environ["CLICKRUNTIME_TOKEN"], api_url()
    p = read_credentials()["profiles"].get(profile)
    if not p or not p.get("access_token"):
        raise CliError("not_signed_in", "Not signed in to ClickRuntime. Run clickruntime login.", Exit.SIGNED_OUT, SIGN_IN_NEXT)
    hosts = profile_hosts(p)
    if _fresh(p) or not p.get("refresh_token"):
        return p["access_token"], hosts["api"]
    with _CredentialsLock():
        # Another process may have refreshed while this one waited for the lock.
        cur = read_credentials()["profiles"].get(profile)
        if not cur or not cur.get("access_token"):
            raise CliError("not_signed_in", "Not signed in to ClickRuntime. Run clickruntime login.", Exit.SIGNED_OUT, SIGN_IN_NEXT)
        cur_hosts = profile_hosts(cur)
        if _fresh(cur) or not cur.get("refresh_token"):
            return cur["access_token"], cur_hosts["api"]
        status, body = oauth_post("/oauth/token", {"grant_type": "refresh_token", "refresh_token": cur["refresh_token"], "client_id": CLIENT_ID},
                                  cur_hosts["auth"])
        if status != 200 or not body.get("access_token"):
            raise CliError("signed_out", "The ClickRuntime sign-in ended. Run clickruntime login again.", Exit.SIGNED_OUT, SIGN_IN_NEXT)
        save_profile(profile, profile_from_token(body, cur))
        return body["access_token"], cur_hosts["api"]


_latest_warned = False


def _newer(a: str, b: str) -> bool:
    def parts(v):
        out = []
        for x in v.split(".")[:3]:
            try:
                out.append(int(x))
            except ValueError:
                out.append(0)
        return out + [0] * (3 - len(out))

    return parts(a) > parts(b)


def call(profile: str, op_id: str, path: Optional[Dict[str, str]] = None, query: Optional[Dict[str, Any]] = None,
         body: Any = None, idempotency_key: Optional[str] = None, anonymous: bool = False) -> Dict[str, Any]:
    """Calls an API operation by operationId. API errors raise CliError with the API's code."""
    global _latest_warned
    op = OPERATIONS[op_id]
    url_path = op["path"]
    for name in op["path_params"]:
        v = (path or {}).get(name)
        if not v:
            raise CliError("usage", "Missing %s." % name, Exit.USAGE)
        url_path = url_path.replace("{%s}" % name, urllib.parse.quote(v, safe=""))
    qs = {}
    for name in op["query_params"]:
        v = (query or {}).get(name)
        if v is None or v == "":
            continue
        qs[name] = ("true" if v else "false") if isinstance(v, bool) else str(v)
    headers = {"Accept": "application/json", "User-Agent": "clickruntime-cli/%s python" % VERSION}
    base = api_url()
    if not anonymous:
        token, base = access_token(profile)
        headers["Authorization"] = "Bearer " + token
    url = base + url_path + ("?" + urllib.parse.urlencode(qs) if qs else "")
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    status, res_headers, raw = _request(op["method"], url, headers, data)
    latest = res_headers.get("ClickRuntime-CLI-Latest") if res_headers else None
    if latest and not _latest_warned and _newer(latest, VERSION):
        _latest_warned = True
        sys.stderr.write("A newer ClickRuntime CLI is available (%s). Update with: pipx upgrade clickruntime-cli\n" % latest)
    try:
        out = json.loads(raw.decode() or "{}")
    except ValueError:
        out = {"error": "bad_response", "message": "Unexpected response (%d)." % status}
    if status >= 400:
        exit_code = Exit.SIGNED_OUT if status == 401 else Exit.RATE_LIMITED if status == 429 else Exit.ERROR
        details = dict(out.get("details") or {})
        if status == 429 and "retry_after_seconds" not in details:
            retry = (res_headers.get("Retry-After") or res_headers.get("RateLimit-Reset")) if res_headers else None
            if retry and retry.isdigit():
                details["retry_after_seconds"] = int(retry)
        raise CliError(out.get("error") or "http_%d" % status, out.get("message") or "Request failed (%d)." % status,
                       exit_code, out.get("next"), details or None)
    return out
