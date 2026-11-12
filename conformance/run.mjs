#!/usr/bin/env node
// Conformance suite: runs every case in cases/*.json against a CLI and a mock API.
//
//   node conformance/run.mjs node      (needs node/dist: cd node && npm run build)
//   node conformance/run.mjs python
//   node conformance/run.mjs all
//
// A case: {name, args, env?, credentials?, files?, mocks: [...], expect: {exit, json?, stdout_contains?, files?}}
// A mock: {method, path, query?, status?, body?, headers?, expect_headers?, expect_body?, expect_form?, times?}
// Mocks are matched in order of definition among those with times left (default 1).
// Every mock must be used, and every request must match a mock.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const IMPLS = {
  node: { cmd: process.execPath, args: [join(root, "node", "dist", "cli.js")], env: {} },
  python: { cmd: process.env.PYTHON || "python", args: ["-m", "clickruntime_cli"], env: { PYTHONPATH: join(root, "python"), PYTHONIOENCODING: "utf-8" } },
};

function subset(want, got, path = "$") {
  if (want === null || typeof want !== "object") {
    if (want === "<any>") return got === undefined ? [`${path}: missing`] : [];
    if (want === "<absent>") return got === undefined ? [] : [`${path}: should be absent, got ${JSON.stringify(got)}`];
    return want === got ? [] : [`${path}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return [`${path}: want array of ${want.length}, got ${JSON.stringify(got)}`];
    return want.flatMap((w, i) => subset(w, got[i], `${path}[${i}]`));
  }
  if (got === null || typeof got !== "object") return [`${path}: want object, got ${JSON.stringify(got)}`];
  return Object.entries(want).flatMap(([k, w]) => subset(w, got[k], `${path}.${k}`));
}

function lastJSON(stdout) {
  // The result is the last JSON object; login --json may print a one-line progress object first.
  const text = stdout.trim();
  for (let i = text.lastIndexOf("\n{"); ; i = text.lastIndexOf("\n{", i - 1)) {
    const start = i < 0 ? 0 : i + 1;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      if (i < 0) return undefined;
    }
  }
}

async function runCase(impl, c) {
  const failures = [];
  const mocks = c.mocks.map((m) => ({ ...m, left: m.times ?? 1, used: 0 }));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url, "http://x");
    const m = mocks.find((m) => m.left > 0 && m.method === req.method && m.path === u.pathname && (!m.query || Object.entries(m.query).every(([k, v]) => u.searchParams.get(k) === String(v))));
    if (!m) {
      failures.push(`unexpected request ${req.method} ${req.url}`);
      res.writeHead(599, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unexpected", message: "unexpected request" }));
      return;
    }
    m.left--;
    m.used++;
    for (const [k, v] of Object.entries(m.expect_headers ?? {})) {
      const got = req.headers[k.toLowerCase()];
      if (v === null ? got !== undefined : v === "<any>" ? got === undefined : got !== v) failures.push(`${m.method} ${m.path}: header ${k} = ${JSON.stringify(got)}, want ${JSON.stringify(v)}`);
    }
    if (m.expect_body) {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {}
      failures.push(...subset(m.expect_body, body, `${m.method} ${m.path} body`));
    }
    if (m.expect_form) {
      const form = Object.fromEntries(new URLSearchParams(raw));
      failures.push(...subset(m.expect_form, form, `${m.method} ${m.path} form`));
    }
    // A string body is sent as text (markdown pages); anything else as JSON.
    const text = typeof m.body === "string";
    res
      .writeHead(m.status ?? 200, { "Content-Type": text ? "text/markdown; charset=utf-8" : "application/json", ...(m.headers ?? {}) })
      .end(text ? m.body : JSON.stringify(m.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const work = mkdtempSync(join(tmpdir(), "cr-conf-"));
  const config = join(work, "config");
  const cwd = join(work, "cwd");
  mkdirSync(config, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (c.credentials) writeFileSync(join(config, "credentials.json"), JSON.stringify({ profiles: c.credentials }));
  if (c.pending) writeFileSync(join(config, "pending-default.json"), JSON.stringify(c.pending));
  for (const [p, content] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(cwd, p)), { recursive: true });
    writeFileSync(join(cwd, p), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  const now = Math.floor(Date.now() / 1000);
  const env = {
    ...process.env,
    ...impl.env,
    CLICKRUNTIME_API_URL: `${base}/api/v1`,
    CLICKRUNTIME_AUTH_URL: base,
    CLICKRUNTIME_CONFIG_DIR: config,
    CLICKRUNTIME_POLL_MS: "10",
    ...Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, String(v).replace("<now+3600>", String(now + 3600))])),
  };
  delete env.CLICKRUNTIME_TOKEN;
  if (c.env?.CLICKRUNTIME_TOKEN) env.CLICKRUNTIME_TOKEN = c.env.CLICKRUNTIME_TOKEN;

  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn(impl.cmd, [...impl.args, ...c.args], { cwd, env });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: errOut });
    });
  });
  server.close();

  const e = c.expect;
  if (e.exit !== undefined && code !== e.exit) failures.push(`exit ${code}, want ${e.exit}`);
  if (e.json) {
    const got = lastJSON(stdout);
    if (got === undefined) failures.push(`stdout is not JSON: ${stdout.slice(0, 300)}`);
    else failures.push(...subset(e.json, got, "stdout"));
  }
  for (const s of e.stdout_contains ?? []) if (!stdout.includes(s)) failures.push(`stdout lacks ${JSON.stringify(s)}`);
  for (const s of e.never_contains ?? []) if (stdout.includes(s) || stderr.includes(s)) failures.push(`output contains ${JSON.stringify(s)}`);
  for (const [p, want] of Object.entries(e.files ?? {})) {
    const full = p.startsWith("config:") ? join(config, p.slice(7)) : join(cwd, p);
    if (want === null) {
      if (existsSync(full)) failures.push(`${p} should not exist`);
      continue;
    }
    if (!existsSync(full)) {
      failures.push(`${p} missing`);
      continue;
    }
    const text = readFileSync(full, "utf8");
    if (typeof want === "string") {
      if (!text.includes(want)) failures.push(`${p} lacks ${JSON.stringify(want)}`);
    } else {
      failures.push(...subset(want, JSON.parse(text), p));
    }
  }
  for (const m of mocks) if (m.left > 0 && !m.optional) failures.push(`mock not used: ${m.method} ${m.path}`);
  if (failures.length && process.env.VERBOSE) failures.push(`stdout: ${stdout}\nstderr: ${stderr}`);
  return failures;
}

const which = process.argv[2] ?? "all";
const impls = which === "all" ? Object.keys(IMPLS) : [which];
const only = process.argv[3];
const cases = readdirSync(join(here, "cases"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(here, "cases", f), "utf8")) }))
  .filter((c) => !only || c.file.includes(only));

let failed = 0;
for (const name of impls) {
  const impl = IMPLS[name];
  if (!impl) {
    console.error(`unknown implementation ${name}`);
    process.exit(2);
  }
  for (const c of cases) {
    const failures = await runCase(impl, c);
    if (failures.length) {
      failed++;
      console.log(`FAIL ${name} ${c.file}: ${c.name}\n  ${failures.join("\n  ")}`);
    } else {
      console.log(`ok   ${name} ${c.file}`);
    }
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length * impls.length} passed`);
process.exit(failed ? 1 : 0);
