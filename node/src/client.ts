// HTTP client over the generated operation table, plus the credentials file and token refresh.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { operations, type OperationId, type Responses } from "./generated.js";

export const CLIENT_ID = "clickruntime-cli";
export const SCOPES = "openid email workspace:read automations:draft automations:control offline_access";
export const VERSION = "0.1.0";

export const EXIT = { ok: 0, error: 1, usage: 2, signedOut: 3, waiting: 4, rateLimited: 5, cancelled: 6 } as const;

export interface Next {
  action?: string;
  url?: string;
  say: string;
}

/** A failure that ends the command: printed as {error, message, next?, details?} with an exit code. */
export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exit: number = EXIT.error,
    public next?: Next,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  toJSON() {
    const out: Record<string, unknown> = { error: this.code, message: this.message };
    if (this.next) out.next = this.next;
    if (this.details) out.details = this.details;
    return out;
  }
}

export function apiURL(): string {
  return checkedURL("CLICKRUNTIME_API_URL", process.env.CLICKRUNTIME_API_URL || "https://clickruntime.com/api/v1");
}

export function authURL(): string {
  return checkedURL("CLICKRUNTIME_AUTH_URL", process.env.CLICKRUNTIME_AUTH_URL || "https://clickruntime.com");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A base URL with no trailing slash. Tokens go only over https, or plain http to this machine. */
function checkedURL(name: string, raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new CliError("usage", `${name} is not a URL: ${v}`, EXIT.usage);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))) {
    throw new CliError("usage", `${name} must use https (plain http only for localhost): ${v}`, EXIT.usage);
  }
  return v;
}

/**
 * The hosts a saved sign-in may be sent to: the ones it was issued by. If CLICKRUNTIME_API_URL or
 * CLICKRUNTIME_AUTH_URL now names another host, the token is not sent there (it could be a value a
 * repository's .env planted); the person signs in again for that host instead.
 */
export function profileHosts(p: Profile): { api: string; auth: string } {
  const api = p.api_url ?? apiURL();
  const auth = p.auth_url ?? authURL();
  const wantAPI = apiURL();
  const wantAuth = authURL();
  if (api !== wantAPI || auth !== wantAuth) {
    const other = api !== wantAPI ? wantAPI : wantAuth;
    throw new CliError(
      "other_host",
      `This sign-in is for ${api !== wantAPI ? api : auth}, but the CLI is set to use ${other}. Run clickruntime login to sign in there, or unset CLICKRUNTIME_API_URL and CLICKRUNTIME_AUTH_URL.`,
      EXIT.signedOut,
      signInNext,
    );
  }
  return { api, auth };
}

export function configDir(): string {
  if (process.env.CLICKRUNTIME_CONFIG_DIR) return process.env.CLICKRUNTIME_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "clickruntime");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "clickruntime");
}

export interface Profile {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  auth_url?: string;
  api_url?: string;
}

interface CredentialsFile {
  profiles: Record<string, Profile>;
}

const credentialsPath = () => join(configDir(), "credentials.json");

export function readCredentials(): CredentialsFile {
  try {
    const data = JSON.parse(readFileSync(credentialsPath(), "utf8")) as CredentialsFile;
    if (data && typeof data.profiles === "object" && data.profiles) return data;
  } catch {
    // missing or unreadable: no profiles
  }
  return { profiles: {} };
}

export function writeJSONPrivate(path: string, data: unknown) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the file sits in the user's profile directory
  }
}

export function saveProfile(name: string, p: Profile) {
  const creds = readCredentials();
  creds.profiles[name] = p;
  writeJSONPrivate(credentialsPath(), creds);
}

export function deleteProfile(name: string) {
  const creds = readCredentials();
  delete creds.profiles[name];
  if (Object.keys(creds.profiles).length === 0) {
    rmSync(credentialsPath(), { force: true });
  } else {
    writeJSONPrivate(credentialsPath(), creds);
  }
}

export const pendingPath = (profile: string) => join(configDir(), `pending-${profile}.json`);
export const hasPending = (profile: string) => existsSync(pendingPath(profile));

export const signInNext: Next = {
  action: "login",
  say: "I need you to sign in to ClickRuntime: I will run clickruntime login and give you a link.",
};

/** Form POST to the OAuth server. Returns the JSON body and status. */
export async function oauthPost(
  path: string,
  form: Record<string, string>,
  base: string = authURL(),
): Promise<{ status: number; body: Record<string, any> }> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) {
    throw new CliError("network_error", `Could not reach ${base}: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}

export function profileFromToken(body: Record<string, any>, prev?: Profile): Profile {
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? prev?.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600),
    auth_url: prev?.auth_url ?? authURL(),
    api_url: prev?.api_url ?? apiURL(),
  };
}

const fresh = (p?: Profile) => Boolean(p?.access_token && p.expires_at && p.expires_at - 60 > Date.now() / 1000);

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

/**
 * Runs fn while holding credentials.lock, so parallel CLI processes refresh one at a time. Two
 * processes sending the same refresh token would look like token theft to the server, which then
 * ends the sign-in. A lock older than LOCK_STALE_MS is from a process that died and is taken over.
 */
async function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const lock = join(configDir(), "credentials.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // removed between the two calls
      }
      if (Date.now() > deadline) {
        throw new CliError("busy", "Another clickruntime command is refreshing the sign-in. Try again in a few seconds.");
      }
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** The access token for profile, refreshed when it is about to expire. Throws exit 3 when signed out. */
export async function accessToken(profileName: string): Promise<{ token: string; api: string }> {
  if (process.env.CLICKRUNTIME_TOKEN) return { token: process.env.CLICKRUNTIME_TOKEN, api: apiURL() };
  const p = readCredentials().profiles[profileName];
  if (!p?.access_token) {
    throw new CliError("not_signed_in", "Not signed in to ClickRuntime. Run clickruntime login.", EXIT.signedOut, signInNext);
  }
  const hosts = profileHosts(p);
  if (fresh(p) || !p.refresh_token) return { token: p.access_token, api: hosts.api };
  return withCredentialsLock(async () => {
    // Another process may have refreshed while this one waited for the lock.
    const cur = readCredentials().profiles[profileName];
    if (!cur?.access_token) {
      throw new CliError("not_signed_in", "Not signed in to ClickRuntime. Run clickruntime login.", EXIT.signedOut, signInNext);
    }
    const curHosts = profileHosts(cur);
    if (fresh(cur) || !cur.refresh_token) return { token: cur.access_token, api: curHosts.api };
    const { status, body } = await oauthPost(
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: cur.refresh_token, client_id: CLIENT_ID },
      curHosts.auth,
    );
    if (status !== 200 || !body.access_token) {
      throw new CliError("signed_out", "The ClickRuntime sign-in ended. Run clickruntime login again.", EXIT.signedOut, signInNext);
    }
    saveProfile(profileName, profileFromToken(body, cur));
    return { token: body.access_token as string, api: curHosts.api };
  });
}

export interface CallInput {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /** No token (public routes). */
  anonymous?: boolean;
}

let latestWarned = false;

/** Calls an API operation by operationId. API errors become CliError with the API's code. */
export async function call<K extends OperationId>(profile: string, id: K, input: CallInput = {}): Promise<Responses[K]> {
  const op = operations[id];
  let path: string = op.path;
  for (const name of op.pathParams) {
    const v = input.path?.[name];
    if (!v) throw new CliError("usage", `Missing ${name}.`, EXIT.usage);
    path = path.replace(`{${name}}`, encodeURIComponent(v));
  }
  const qs = new URLSearchParams();
  for (const name of op.queryParams) {
    const v = input.query?.[name];
    if (v !== undefined && v !== "") qs.set(name, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": `clickruntime-cli/${VERSION} node` };
  let base = apiURL();
  if (!input.anonymous) {
    const t = await accessToken(profile);
    headers.Authorization = `Bearer ${t.token}`;
    base = t.api;
  }
  const url = base + path + (qs.size ? `?${qs}` : "");
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, { method: op.method, headers, body: input.body !== undefined ? JSON.stringify(input.body) : undefined });
  } catch (e) {
    throw new CliError("network_error", `Could not reach ${base}: ${(e as Error).message}`);
  }
  const latest = res.headers.get("ClickRuntime-CLI-Latest");
  if (latest && !latestWarned && newer(latest, VERSION)) {
    latestWarned = true;
    process.stderr.write(`A newer ClickRuntime CLI is available (${latest}). Update with: npm install -g clickruntime@latest\n`);
  }
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: "bad_response", message: `Unexpected response (${res.status}).` };
  }
  if (!res.ok) {
    const exit = res.status === 401 ? EXIT.signedOut : res.status === 429 ? EXIT.rateLimited : EXIT.error;
    const details = { ...(body.details ?? {}) } as Record<string, unknown>;
    if (res.status === 429 && details.retry_after_seconds === undefined) {
      const retry = Number(res.headers.get("Retry-After") ?? res.headers.get("RateLimit-Reset"));
      if (retry) details.retry_after_seconds = retry;
    }
    throw new CliError(
      body.error || `http_${res.status}`,
      body.message || `Request failed (${res.status}).`,
      exit,
      body.next,
      Object.keys(details).length ? details : undefined,
    );
  }
  return body as Responses[K];
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
