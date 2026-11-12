// Sign-in: OAuth loopback with PKCE, falling back to the device authorization grant (RFC 8628).
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { AddressInfo } from "node:net";
import {
  CLIENT_ID,
  CliError,
  EXIT,
  SCOPES,
  apiURL,
  authURL,
  hasPending,
  oauthPost,
  pendingPath,
  profileFromToken,
  saveProfile,
  writeJSONPrivate,
  type Next,
} from "./client.js";

const LOOPBACK_TIMEOUT_MS = Number(process.env.CLICKRUNTIME_LOOPBACK_TIMEOUT_MS || 300_000);

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Pages shown in the browser after the loopback redirect. Same tokens as the OAuth pages
// (platform/backend/internal/oauth/pages.go, "magenta graphite"), light and dark.
const PAGE_OK = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"dark\"><meta name=\"robots\" content=\"noindex\"><title>Signed in \u00b7 ClickRuntime</title><style>:root{--bg:#0A0A0C;--p1:#0E0E12;--p2:#131318;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--fg:#EDEDF0;--mut:#A3A3AF;--dim:#6B6B78;--white:#fff;--acc:#FF4FA3;--ok:#4ADE80;--bad:#FF6B6B;--sans:Geist,ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;--mono:\"Geist Mono\",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:400 16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}.hdr{height:52px;display:flex;align-items:center;padding:0 20px;border-bottom:1px solid var(--line)}.brand{display:inline-flex;align-items:center;gap:10px;font:600 16px var(--sans);letter-spacing:-.01em;color:var(--white)}.brand svg{width:22px;height:22px}main{flex:1;display:flex;justify-content:center;align-items:center;padding:48px 16px}.card{width:100%;max-width:440px;border:1px solid var(--line2);border-radius:6px;background:var(--p1);padding:28px}.icon{width:40px;height:40px;border-radius:6px;display:flex;align-items:center;justify-content:center;margin-bottom:18px;border:1px solid rgba(74,222,128,.3);background:rgba(74,222,128,.08);color:var(--ok)}.icon.bad{border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08);color:var(--bad)}.icon svg{width:20px;height:20px}h1{font-size:26px;line-height:1.2;letter-spacing:-.025em;margin:0 0 10px;font-weight:600;color:var(--white)}p{margin:0 0 16px}.lede{color:var(--mut)}code{font-family:var(--mono);font-size:.88em;color:var(--acc);background:var(--bg);border:1px solid var(--line2);border-radius:4px;padding:1px 6px}.btn{display:flex;justify-content:center;width:100%;font:500 15px/1 var(--sans);padding:13px 18px;border-radius:6px;border:1px solid var(--line2);background:var(--p2);color:var(--fg);text-decoration:none;margin-top:20px}.btn:hover{border-color:rgba(255,255,255,.4)}:focus-visible{outline:2px solid var(--acc);outline-offset:2px}@media (max-width:520px){.card{padding:22px 18px}h1{font-size:23px}}</style></head><body><header class=\"hdr\"><div class=\"brand\"><svg viewBox=\"0 0 512 512\" aria-hidden=\"true\"><rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#B8226C\"/><path transform=\"translate(15.33 45.67) scale(.82)\" fill=\"#FFFFFF\" d=\"M179.56 49.3C176.635 49.3 173.807 49.9825 171.24 51.12C139.292 65.5175 163.31 157.688 194.12 233.38C197.142 201.985 223.825 177.22 256 177.22C269.487 177.22 281.935 181.835 292.14 189.18C292.205 189.213 292.335 189.148 292.4 189.18C260.257 124.18 211.865 49.3 179.56 49.3ZM292.4 189.18C307.902 200.458 318.14 218.755 318.14 239.36C318.14 264.515 303.027 286.29 281.48 296.04C298.217 297.113 314.695 297.86 330.36 297.86C368.71 297.86 458.247 294.058 461.66 260.16C465.17 225.353 373.325 200.36 292.4 189.18ZM281.48 296.04C281.317 296.105 281.122 295.975 280.96 296.04C273.29 299.453 264.905 301.5 256 301.5C221.777 301.5 193.86 273.583 193.86 239.36C193.86 237.313 194.185 235.363 194.38 233.38C149.075 301.37 106.695 386.878 135.1 407.32C138.642 409.855 142.965 411.22 147.84 411.22C180.6 411.22 239.912 349.503 281.48 296.04ZM256 193.6C230.78 193.6 210.24 214.14 210.24 239.36C210.24 264.58 230.78 285.12 256 285.12C281.22 285.12 301.76 264.58 301.76 239.36C301.76 214.14 281.22 193.6 256 193.6ZM256 218.56C267.472 218.56 276.8 227.855 276.8 239.36C276.8 250.865 267.472 260.16 256 260.16C244.495 260.16 235.2 250.865 235.2 239.36C235.2 227.855 244.495 218.56 256 218.56ZM285.12 319.44C269.097 339.298 246.607 365.525 222.72 387.3L217 454.9C216.805 457.208 217.487 459.418 219.08 461.14C220.672 462.863 222.98 464 225.32 464H286.68C288.987 464 291.1 462.83 292.66 461.14C294.22 459.45 295.162 457.208 295 454.9L285.12 319.44Z\"/></svg>ClickRuntime</div></header><main><div class=\"card\"><div class=\"icon\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg></div><h1>You\u2019re signed in</h1><p class=\"lede\">The ClickRuntime CLI is connected to your workspace. Close this tab and go back to your agent.</p><a class=\"btn\" href=\"{{DASHBOARD}}\">Open the ClickRuntime dashboard</a></div></main></body></html>";
const PAGE_FAILED = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"dark\"><meta name=\"robots\" content=\"noindex\"><title>Sign-in not completed \u00b7 ClickRuntime</title><style>:root{--bg:#0A0A0C;--p1:#0E0E12;--p2:#131318;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--fg:#EDEDF0;--mut:#A3A3AF;--dim:#6B6B78;--white:#fff;--acc:#FF4FA3;--ok:#4ADE80;--bad:#FF6B6B;--sans:Geist,ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;--mono:\"Geist Mono\",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:400 16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}.hdr{height:52px;display:flex;align-items:center;padding:0 20px;border-bottom:1px solid var(--line)}.brand{display:inline-flex;align-items:center;gap:10px;font:600 16px var(--sans);letter-spacing:-.01em;color:var(--white)}.brand svg{width:22px;height:22px}main{flex:1;display:flex;justify-content:center;align-items:center;padding:48px 16px}.card{width:100%;max-width:440px;border:1px solid var(--line2);border-radius:6px;background:var(--p1);padding:28px}.icon{width:40px;height:40px;border-radius:6px;display:flex;align-items:center;justify-content:center;margin-bottom:18px;border:1px solid rgba(74,222,128,.3);background:rgba(74,222,128,.08);color:var(--ok)}.icon.bad{border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08);color:var(--bad)}.icon svg{width:20px;height:20px}h1{font-size:26px;line-height:1.2;letter-spacing:-.025em;margin:0 0 10px;font-weight:600;color:var(--white)}p{margin:0 0 16px}.lede{color:var(--mut)}code{font-family:var(--mono);font-size:.88em;color:var(--acc);background:var(--bg);border:1px solid var(--line2);border-radius:4px;padding:1px 6px}.btn{display:flex;justify-content:center;width:100%;font:500 15px/1 var(--sans);padding:13px 18px;border-radius:6px;border:1px solid var(--line2);background:var(--p2);color:var(--fg);text-decoration:none;margin-top:20px}.btn:hover{border-color:rgba(255,255,255,.4)}:focus-visible{outline:2px solid var(--acc);outline-offset:2px}@media (max-width:520px){.card{padding:22px 18px}h1{font-size:23px}}</style></head><body><header class=\"hdr\"><div class=\"brand\"><svg viewBox=\"0 0 512 512\" aria-hidden=\"true\"><rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#B8226C\"/><path transform=\"translate(15.33 45.67) scale(.82)\" fill=\"#FFFFFF\" d=\"M179.56 49.3C176.635 49.3 173.807 49.9825 171.24 51.12C139.292 65.5175 163.31 157.688 194.12 233.38C197.142 201.985 223.825 177.22 256 177.22C269.487 177.22 281.935 181.835 292.14 189.18C292.205 189.213 292.335 189.148 292.4 189.18C260.257 124.18 211.865 49.3 179.56 49.3ZM292.4 189.18C307.902 200.458 318.14 218.755 318.14 239.36C318.14 264.515 303.027 286.29 281.48 296.04C298.217 297.113 314.695 297.86 330.36 297.86C368.71 297.86 458.247 294.058 461.66 260.16C465.17 225.353 373.325 200.36 292.4 189.18ZM281.48 296.04C281.317 296.105 281.122 295.975 280.96 296.04C273.29 299.453 264.905 301.5 256 301.5C221.777 301.5 193.86 273.583 193.86 239.36C193.86 237.313 194.185 235.363 194.38 233.38C149.075 301.37 106.695 386.878 135.1 407.32C138.642 409.855 142.965 411.22 147.84 411.22C180.6 411.22 239.912 349.503 281.48 296.04ZM256 193.6C230.78 193.6 210.24 214.14 210.24 239.36C210.24 264.58 230.78 285.12 256 285.12C281.22 285.12 301.76 264.58 301.76 239.36C301.76 214.14 281.22 193.6 256 193.6ZM256 218.56C267.472 218.56 276.8 227.855 276.8 239.36C276.8 250.865 267.472 260.16 256 260.16C244.495 260.16 235.2 250.865 235.2 239.36C235.2 227.855 244.495 218.56 256 218.56ZM285.12 319.44C269.097 339.298 246.607 365.525 222.72 387.3L217 454.9C216.805 457.208 217.487 459.418 219.08 461.14C220.672 462.863 222.98 464 225.32 464H286.68C288.987 464 291.1 462.83 292.66 461.14C294.22 459.45 295.162 457.208 295 454.9L285.12 319.44Z\"/></svg>ClickRuntime</div></header><main><div class=\"card\"><div class=\"icon bad\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M7 7l10 10M17 7L7 17\"/></svg></div><h1>Sign-in was not completed</h1><p class=\"lede\">{{REASON}} Go back to your agent and run <code>clickruntime login</code> again.</p></div></main></body></html>";
const escapeHTML = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const donePage = () => PAGE_OK.replace("{{DASHBOARD}}", escapeHTML(authURL() + "/home"));
const failedPage = (reason: string) => PAGE_FAILED.replace("{{REASON}}", escapeHTML(reason));

function openBrowser(url: string): boolean {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.replace(/&/g, "^&")] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** A browser sign-in waiting on its loopback callback. */
interface Loopback {
  /** False when the browser could not be opened. */
  opened: boolean;
  /** Resolves with the authorization code, null when the person cancelled in the browser, or never once closed. */
  result: Promise<string | null>;
  /** Exchanges the code for tokens and saves the sign-in. */
  finish(code: string): Promise<void>;
  /** Stops listening; a later browser redirect finds nothing. */
  close(): void;
}

/**
 * Starts the loopback sign-in: listens on 127.0.0.1, opens the browser at /oauth/authorize and waits
 * for the callback. It keeps listening until close(), also while the CLI offers a device code, so
 * Allow in a consent page left open still works (the server expires the page when the CLI stops).
 */
async function startLoopback(profile0: string, progress: (s: string) => void): Promise<Loopback> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  let settle: (code: string | null) => void = () => undefined;
  const result = new Promise<string | null>((resolve) => (settle = resolve));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (u.searchParams.get("state") !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(failedPage("This sign-in link does not match the one the CLI started."));
      return;
    }
    const got = u.searchParams.get("code");
    res.writeHead(got ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(got ? donePage() : failedPage("ClickRuntime did not approve the sign-in."));
    server.close();
    settle(got);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: apiURL(),
  });
  const url = `${authURL()}/oauth/authorize?${q}`;
  progress(`Opening the browser to sign in. If it does not open, visit:
${url}`);
  const opened = openBrowser(url);
  return {
    opened,
    result,
    close: () => server.close(),
    async finish(code: string) {
      const { status, body } = await oauthPost("/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: apiURL(),
      });
      if (status !== 200 || !body.access_token) {
        throw new CliError(body.error || "login_failed", body.error_description || "Sign-in failed. Run clickruntime login again.");
      }
      saveProfile(profile0, profileFromToken(body));
    },
  };
}

interface Pending {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_at: number;
}

export function deviceNext(p: Pick<Pending, "verification_uri" | "user_code">): Next {
  return {
    action: "open_link",
    url: p.verification_uri,
    say: `Open ${p.verification_uri} and enter ${p.user_code} to connect ClickRuntime.`,
  };
}

async function startDevice(profile: string): Promise<Pending> {
  const { status, body } = await oauthPost("/oauth/device_authorization", { client_id: CLIENT_ID, scope: SCOPES, resource: apiURL() });
  if (status !== 200 || !body.device_code) {
    throw new CliError(body.error || "login_failed", body.error_description || "Could not start the device sign-in.");
  }
  const p: Pending = {
    device_code: body.device_code,
    user_code: body.user_code,
    // Never a link with the code in it: the person types the code on the page.
    verification_uri: String(body.verification_uri || "").split("?")[0],
    interval: Number(body.interval || 5),
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in || 600),
  };
  writeJSONPrivate(pendingPath(profile), p);
  return p;
}


/** Ends a device poll early: the browser sign-in finished first. */
interface Stop {
  stopped: boolean;
  wake?: () => void;
}

async function pollDevice(profile: string, p: Pending, stop: Stop = { stopped: false }): Promise<void> {
  let interval = p.interval;
  for (;;) {
    if (stop.stopped) return;
    if (Date.now() / 1000 > p.expires_at) {
      rmSync(pendingPath(profile), { force: true });
      throw new CliError("expired_token", "The sign-in code expired. Run clickruntime login again.", EXIT.cancelled);
    }
    const { status, body } = await oauthPost("/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: p.device_code,
      client_id: CLIENT_ID,
    });
    if (stop.stopped) return;
    if (status === 200 && body.access_token) {
      saveProfile(profile, profileFromToken(body));
      rmSync(pendingPath(profile), { force: true });
      return;
    }
    switch (body.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval += 5;
        break;
      case "access_denied":
        rmSync(pendingPath(profile), { force: true });
        throw new CliError("access_denied", "The sign-in was denied.", EXIT.cancelled);
      case "expired_token":
        rmSync(pendingPath(profile), { force: true });
        throw new CliError("expired_token", "The sign-in code expired. Run clickruntime login again.", EXIT.cancelled);
      default:
        rmSync(pendingPath(profile), { force: true });
        throw new CliError(body.error || "login_failed", body.error_description || "Sign-in failed. Run clickruntime login again.");
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, interval * 1000);
      stop.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

export interface LoginOptions {
  device: boolean;
  noBrowser: boolean;
  noWait: boolean;
  continuePending: boolean;
  /** Called with next when the person must open a link (device sign-in). */
  announce: (next: Next, userCode: string) => void;
  progress: (s: string) => void;
}

export async function login(profile: string, o: LoginOptions): Promise<"signed_in" | "waiting"> {
  if (o.continuePending) {
    if (!hasPending(profile)) throw new CliError("usage", "There is no pending sign-in. Run clickruntime login.", EXIT.usage);
    const p = JSON.parse(readFileSync(pendingPath(profile), "utf8")) as Pending;
    await pollDevice(profile, p);
    return "signed_in";
  }
  if (!o.device && !o.noBrowser && !o.noWait) return browserLogin(profile, o);
  const p = await startDevice(profile);
  o.announce(deviceNext(p), p.user_code);
  if (o.noWait) return "waiting";
  await pollDevice(profile, p);
  return "signed_in";
}

const DENIED = () => new CliError("access_denied", "The sign-in was cancelled in the browser.", EXIT.cancelled);

/**
 * Browser sign-in with a device code as the fallback. After LOOPBACK_TIMEOUT_MS without a callback
 * the CLI also offers a code, but keeps waiting for the browser: whichever the person finishes first
 * signs in, and the other is dropped.
 */
async function browserLogin(profile: string, o: LoginOptions): Promise<"signed_in"> {
  const lb = await startLoopback(profile, o.progress);
  try {
    if (lb.opened) {
      let timer: NodeJS.Timeout | undefined;
      const first = await Promise.race([
        lb.result,
        new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), LOOPBACK_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
      if (first === null) throw DENIED();
      if (first) {
        await lb.finish(first);
        return "signed_in";
      }
      o.progress("Still waiting for the browser. You can also sign in with a code instead:");
    }
    const p = await startDevice(profile);
    o.announce(deviceNext(p), p.user_code);
    const stop: Stop = { stopped: false };
    const winner = await Promise.race([
      lb.result.then((code) => ({ code })),
      pollDevice(profile, p, stop).then(() => ({ code: undefined as string | null | undefined })),
    ]);
    stop.stopped = true;
    stop.wake?.();
    if (winner.code === null) throw DENIED();
    if (winner.code) {
      rmSync(pendingPath(profile), { force: true });
      await lb.finish(winner.code);
    }
    return "signed_in";
  } finally {
    lb.close();
  }
}
