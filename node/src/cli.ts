#!/usr/bin/env node
// ClickRuntime CLI. Behaviour: ../../SPEC.md (shared with the Python CLI, checked by conformance/).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT, VERSION, apiURL, authURL, call, deleteProfile, readCredentials, signInNext, type Next } from "./client.js";
import { HELP_TOPICS } from "./generated.js";
import { deviceNext, login } from "./login.js";

// ---- arguments ----

interface Args {
  pos: string[];
  flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set(["json", "wait", "no-wait", "device", "no-browser", "no-wait", "continue", "help", "version"]);

function parse(argv: string[]): Args {
  const out: Args = { pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) out.flags[k] = v;
      else if (BOOL_FLAGS.has(k)) out.flags[k] = true;
      else if (i + 1 < argv.length) out.flags[k] = argv[++i];
      else throw new CliError("usage", `--${k} needs a value.`, EXIT.usage);
    } else if (a === "-h") {
      out.flags.help = true;
    } else {
      out.pos.push(a);
    }
  }
  return out;
}

const str = (a: Args, k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);

function need(a: Args, i: number, what: string): string {
  const v = a.pos[i];
  if (!v) throw new CliError("usage", `Missing ${what}. Run clickruntime --help.`, EXIT.usage);
  return v;
}

function needFlag(a: Args, k: string): string {
  const v = str(a, k);
  if (!v) throw new CliError("usage", `Missing --${k}.`, EXIT.usage);
  return v;
}

// ---- output ----

let jsonMode = false;

const err = (s: string) => process.stderr.write(s + "\n");

function emit(obj: unknown, human?: (o: any) => string) {
  if (jsonMode || !human) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  } else {
    process.stdout.write(human(obj) + "\n");
  }
}

function nextLine(n?: Next | null): string {
  if (!n) return "";
  return `\nNext: ${n.say}${n.url && !n.say.includes(n.url) ? `\n${n.url}` : ""}`;
}

function waitsOnPerson(o: { next?: Next | null }): boolean {
  return o?.next?.action === "open_link";
}

// ---- local project files ----

interface ProjectFile {
  automation_id?: string;
  name: string;
  summary: string;
  pattern: string;
  schedule?: Record<string, unknown>;
  how_it_works: { steps: string[] };
  setup_needs: unknown[];
  dependencies?: unknown[];
  retry?: Record<string, unknown>;
  signature?: Record<string, unknown>;
  script?: string;
}

const TEMPLATES: Record<string, string> = {
  schedule: `from clickruntime import on_trigger, log


@on_trigger
def run(event):
    # Runs on the schedule in clickruntime.json. Read the script reference first:
    # clickruntime docs runtime
    log("running")
    return {"ok": True}
`,
  incoming: `from clickruntime import on_event, log


@on_event
def handle(event):
    # Runs for each event sent to the trigger link. event.body is the JSON payload.
    log("got", event.event_id)
    return {"seen": True}
`,
  remember_then_schedule: `from clickruntime import on_trigger, state, log


@on_trigger
def run(event):
    # Runs on the schedule and keeps what it saw in state between runs.
    seen = state.get("seen", [])
    log("seen so far", len(seen))
    return {"ok": True}
`,
};

function projectPaths(dir: string) {
  return { config: join(dir, "clickruntime.json"), script: join(dir, "automation.py") };
}

function readProject(dir: string): ProjectFile {
  const p = projectPaths(dir);
  if (!existsSync(p.config)) throw new CliError("usage", `No clickruntime.json in ${dir}. Run clickruntime init <name> first.`, EXIT.usage);
  let cfg: ProjectFile;
  try {
    cfg = JSON.parse(readFileSync(p.config, "utf8"));
  } catch {
    throw new CliError("usage", "clickruntime.json is not valid JSON.", EXIT.usage);
  }
  if (!existsSync(p.script)) throw new CliError("usage", `No automation.py in ${dir}.`, EXIT.usage);
  cfg.script = readFileSync(p.script, "utf8");
  return cfg;
}

function writeProject(dir: string, cfg: ProjectFile, script?: string) {
  const p = projectPaths(dir);
  mkdirSync(dir, { recursive: true });
  const { script: _omit, ...rest } = cfg;
  writeFileSync(p.config, JSON.stringify(rest, null, 2) + "\n");
  if (script !== undefined) writeFileSync(p.script, script);
}

// ---- confirmations ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = Number(process.env.CLICKRUNTIME_POLL_MS || 3000);

async function confirmAndWait(profile: string, a: Args, automationId: string, action: string) {
  const conf = await call(profile, "prepareConfirmation", {
    body: { automation_id: automationId, action },
    idempotencyKey: randomUUID(),
  });
  const wait = a.flags.wait === true || (!jsonMode && a.flags["no-wait"] !== true);
  if (!wait) {
    emit(conf, (c) => `${c.name}: ${c.effect ?? action}${nextLine(c.next)}`);
    return EXIT.waiting;
  }
  if (!jsonMode) err(`${conf.next?.say ?? "Open the link to confirm."}\n${conf.links?.confirm ?? ""}\nWaiting for you to confirm…`);
  return waitFor(profile, conf.confirmation_ref, Number(str(a, "timeout") ?? 600));
}

async function waitFor(profile: string, ref: string, timeoutS: number): Promise<number> {
  const until = Date.now() + timeoutS * 1000;
  for (;;) {
    const st = await call(profile, "getConfirmationStatus", { path: { confirmation_ref: ref } });
    if (st.state === "confirmed" || st.state === "used") {
      let automation: unknown = null;
      if ((st.action === "enable" || st.action === "apply_change" || st.action === "resume") && !st.deleted) {
        automation = await call(profile, "waitForDeploy", { path: { automation_id: st.automation_id } }).catch((e) => {
          if (e instanceof CliError && e.code === "not_deployed") return null;
          throw e;
        });
      }
      emit({ state: "confirmed", confirmation: st, automation }, () => `Confirmed: ${st.action} ${st.name}.`);
      return EXIT.ok;
    }
    if (st.state === "cancelled" || st.state === "expired") {
      throw new CliError(
        st.state === "cancelled" ? "confirmation_cancelled" : "confirmation_expired",
        st.state === "cancelled" ? "The person cancelled it." : "The confirmation expired before the person confirmed.",
        EXIT.cancelled,
      );
    }
    if (Date.now() > until) {
      emit(st, () => `Still waiting for the person to confirm. Run clickruntime wait ${ref} to keep waiting.`);
      return EXIT.waiting;
    }
    await sleep(POLL_MS);
  }
}

// ---- commands ----

type Command = (profile: string, a: Args) => Promise<number>;

const commands: Record<string, Command> = {
  async login(profile, a) {
    const result = await login(profile, {
      device: a.flags.device === true,
      noBrowser: a.flags["no-browser"] === true,
      noWait: a.flags["no-wait"] === true,
      continuePending: a.flags.continue === true,
      announce: (next, code) => {
        if (jsonMode && a.flags["no-wait"] === true) return; // printed as the result below
        if (jsonMode) process.stdout.write(JSON.stringify({ state: "waiting", user_code: code, next }) + "\n");
        else err(`${next.say}\nWaiting for you to approve…`);
      },
      progress: (s) => {
        if (!jsonMode) err(s);
      },
    });
    if (result === "waiting") {
      const pending = JSON.parse(readFileSync(join(configDirFor(), `pending-${profile}.json`), "utf8"));
      emit(
        {
          state: "waiting",
          user_code: pending.user_code,
          // A pending file from an older CLI may hold verification_uri_complete; drop its ?code=.
          next: deviceNext({
            user_code: pending.user_code,
            verification_uri: String(pending.verification_uri ?? pending.verification_uri_complete ?? "").split("?")[0],
          }),
        },
        (o) => `${o.next.say}\nThen run: clickruntime login --continue`,
      );
      return EXIT.waiting;
    }
    const me = await call(profile, "getProfile");
    emit({ signed_in: true, email: me.email, profile: profile }, (o) => `Signed in as ${o.email}.`);
    return EXIT.ok;
  },

  async logout(profile) {
    const had = Boolean(readCredentials().profiles[profile]);
    if (had) {
      await call(profile, "signOut").catch((e) => {
        if (!(e instanceof CliError) || e.exit !== EXIT.signedOut) throw e;
      });
      deleteProfile(profile);
    }
    emit({ signed_out: true }, () => (had ? "Signed out." : "Not signed in."));
    return EXIT.ok;
  },

  async status(profile) {
    const env = Boolean(process.env.CLICKRUNTIME_TOKEN);
    if (!env && !readCredentials().profiles[profile]) {
      emit({ signed_in: false, api_url: apiURL(), next: signInNext }, () => `Not signed in. Run: clickruntime login`);
      return EXIT.signedOut;
    }
    try {
      const me = await call(profile, "getProfile");
      emit(
        { signed_in: true, email: me.email, profile_id: me.id, workspace_profile: profile, api_url: apiURL(), token_source: env ? "env" : "file" },
        (o) => `Signed in as ${o.email} (${o.workspace_profile}).`,
      );
      return EXIT.ok;
    } catch (e) {
      if (e instanceof CliError && e.exit === EXIT.signedOut) {
        emit({ signed_in: false, api_url: apiURL(), next: signInNext }, () => `The sign-in ended. Run: clickruntime login`);
        return EXIT.signedOut;
      }
      throw e;
    }
  },

  async init(_profile, a) {
    const name = need(a, 0, "a name");
    const pattern = str(a, "pattern") ?? "schedule";
    if (!TEMPLATES[pattern]) throw new CliError("usage", "--pattern must be schedule, incoming or remember_then_schedule.", EXIT.usage);
    const dir = str(a, "dir") ?? ".";
    const p = projectPaths(dir);
    if (existsSync(p.config) || existsSync(p.script)) throw new CliError("usage", `${dir} already has clickruntime.json or automation.py.`, EXIT.usage);
    const cfg: ProjectFile = {
      name,
      summary: "",
      pattern,
      ...(pattern === "incoming" ? {} : { schedule: { kind: "hourly" } }),
      how_it_works: { steps: [] },
      setup_needs: [],
      dependencies: [],
    };
    writeProject(dir, cfg, TEMPLATES[pattern]);
    emit({ created: [p.config, p.script] }, () => `Wrote ${p.config} and ${p.script}. Fill in summary and how_it_works, then: clickruntime save`);
    return EXIT.ok;
  },

  async save(profile, a) {
    const dir = str(a, "dir") ?? ".";
    const cfg = readProject(dir);
    const fields = ["name", "summary", "schedule", "how_it_works", "setup_needs", "dependencies", "retry", "signature", "script"] as const;
    const body: Record<string, unknown> = {};
    for (const f of fields) if (cfg[f] !== undefined) body[f] = cfg[f];
    let saved;
    if (cfg.automation_id) {
      saved = await call(profile, "updateAutomation", { path: { automation_id: cfg.automation_id }, body });
    } else {
      saved = await call(profile, "saveDraft", { body: { ...body, pattern: cfg.pattern }, idempotencyKey: randomUUID() });
      cfg.automation_id = saved.automation_id;
      writeProject(dir, cfg);
    }
    emit(saved, (s) => `Saved ${s.name} (${s.automation_id}), ${s.status}.${(s.notes ?? []).map((n: string) => `\nNote: ${n}`).join("")}${nextLine(s.next)}`);
    return EXIT.ok;
  },

  async pull(profile, a) {
    const id = need(a, 0, "an automation id");
    const dir = str(a, "dir") ?? ".";
    const aut = await call(profile, "getAutomation", { path: { automation_id: id } });
    const script = await call(profile, "getScript", { path: { automation_id: id } });
    writeProject(
      dir,
      {
        automation_id: aut.automation_id,
        name: aut.name,
        summary: aut.summary,
        pattern: aut.pattern,
        ...(aut.schedule?.spec ? { schedule: aut.schedule.spec } : {}),
        how_it_works: (aut.how_it_works as { steps: string[] }) ?? { steps: [] },
        setup_needs: [],
        dependencies: aut.dependencies ?? [],
        ...(aut.retry ? { retry: aut.retry } : {}),
      },
      script.code,
    );
    emit({ automation_id: id, dir, redacted: script.redacted }, () => `Wrote ${dir}/clickruntime.json and ${dir}/automation.py. Check setup_needs before saving.`);
    return EXIT.ok;
  },

  async list(profile, a) {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await call(profile, "listAutomations", { query: { status: str(a, "status"), cursor, limit: 50 } });
      all.push(...page.automations);
      total = page.total;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    emit({ automations: all, total }, (o) =>
      o.automations.length ? o.automations.map((x: any) => `${x.automation_id}  ${x.status.padEnd(6)}  ${x.name}`).join("\n") : "No automations yet.",
    );
    return EXIT.ok;
  },

  async show(profile, a) {
    const aut = await call(profile, "getAutomation", { path: { automation_id: need(a, 0, "an automation id") } });
    emit(aut, (x) => `${x.name} (${x.automation_id}): ${x.status}\n${x.summary}${x.schedule ? `\n${x.schedule.description}` : ""}${x.trigger ? `\nTrigger link: ${x.trigger.url}` : ""}${nextLine(x.next)}`);
    return EXIT.ok;
  },

  async setup(profile, a) {
    if (a.pos[0] === "run") {
      const file = str(a, "file") ?? "automation.py";
      if (!existsSync(file)) throw new CliError("usage", `No ${file}.`, EXIT.usage);
      const body: Record<string, unknown> = {
        title: needFlag(a, "title"),
        purpose: str(a, "purpose") ?? "discover",
        script: readFileSync(file, "utf8"),
        setup_needs: [],
      };
      if (existsSync("clickruntime.json")) {
        const cfg = JSON.parse(readFileSync("clickruntime.json", "utf8")) as ProjectFile;
        body.setup_needs = cfg.setup_needs ?? [];
        if (cfg.dependencies?.length) body.dependencies = cfg.dependencies;
      }
      if (str(a, "changes")) body.changes = str(a, "changes");
      const run = await call(profile, "runSetupScript", { body, idempotencyKey: randomUUID() });
      emit(run, (r) => `Setup run ${r.setup_run_id}: ${r.status}${r.error ? `\n${r.error}` : ""}${(r.logs ?? []).map((l: unknown) => `\n${typeof l === "string" ? l : JSON.stringify(l)}`).join("")}`);
      return run.status === "failed" || run.status === "timed_out" ? EXIT.error : EXIT.ok;
    }
    const st = await call(profile, "getSetupStatus", { path: { automation_id: need(a, 0, "an automation id") } });
    emit(st, (s) =>
      s.ready
        ? `${s.name}: setup is complete.`
        : `${s.name}: ${s.steps.length} setup step(s) left:\n${s.items
            .filter((i: any) => !i.ready)
            .map((i: any) => `- ${i.name}${i.url ? `: ${i.url}` : ""}`)
            .join("\n")}${nextLine(s.next)}`,
    );
    return waitsOnPerson(st) ? EXIT.waiting : EXIT.ok;
  },

  async deploy(profile, a) {
    const id = need(a, 0, "an automation id");
    const aut = await call(profile, "getAutomation", { path: { automation_id: id } });
    const action = aut.status === "draft" ? "enable" : aut.pending_change ? "apply_change" : aut.status === "paused" ? "resume" : "";
    if (!action) throw new CliError("nothing_to_deploy", "It is already live and has no pending change. Change it with clickruntime save first.", EXIT.error);
    return confirmAndWait(profile, a, id, action);
  },
  run: (profile, a) => confirmAndWait(profile, a, need(a, 0, "an automation id"), "run_now"),
  resume: (profile, a) => confirmAndWait(profile, a, need(a, 0, "an automation id"), "resume"),
  delete: (profile, a) => confirmAndWait(profile, a, need(a, 0, "an automation id"), "delete"),
  wait: (profile, a) => waitFor(profile, need(a, 0, "a confirmation_ref"), Number(str(a, "timeout") ?? 600)),

  async pause(profile, a) {
    const aut = await call(profile, "pauseAutomation", { path: { automation_id: need(a, 0, "an automation id") } });
    emit(aut, (x) => `${x.name} is ${x.status}.`);
    return EXIT.ok;
  },

  async runs(profile, a) {
    const out = await call(profile, "listRuns", {
      path: { automation_id: need(a, 0, "an automation id") },
      query: { status: str(a, "status"), limit: str(a, "limit") ? Number(str(a, "limit")) : undefined },
    });
    emit(out, (o) => (o.runs.length ? o.runs.map((r: any) => `${r.id}  ${r.status.padEnd(9)}  ${r.created_at}  ${r.trigger}`).join("\n") : "No runs yet."));
    return EXIT.ok;
  },

  async "run-log"(profile, a) {
    const run = await call(profile, "getRun", { path: { run_id: need(a, 0, "a run id") }, query: { wait: a.flags.wait === true ? true : undefined } });
    emit(run, (r) => `${r.id}: ${r.status}${r.error ? `\nError: ${r.error}` : ""}${(r.logs ?? []).map((l: unknown) => `\n${typeof l === "string" ? l : JSON.stringify(l)}`).join("")}`);
    return EXIT.ok;
  },

  async events(profile, a) {
    const out = await call(profile, "listIncomingEvents", { path: { automation_id: need(a, 0, "an automation id") } });
    emit(out, (o) => (o.events.length ? o.events.map((e: any) => `${e.id ?? e.event_id}  ${e.received_at ?? ""}`).join("\n") : "No events yet."));
    return EXIT.ok;
  },

  async replay(profile, a) {
    const run = await call(profile, "replayEvent", {
      path: { automation_id: need(a, 0, "an automation id"), event_id: need(a, 1, "an event id") },
      idempotencyKey: randomUUID(),
    });
    emit(run, (r) => `Run ${r.id}: ${r.status}${r.error ? `\n${r.error}` : ""}`);
    return EXIT.ok;
  },

  async "test-event"(profile, a) {
    const file = needFlag(a, "file");
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new CliError("usage", `${file} is not valid JSON.`, EXIT.usage);
    }
    const run = await call(profile, "sendTestEvent", {
      path: { automation_id: need(a, 0, "an automation id") },
      body: { body: payload },
      idempotencyKey: randomUUID(),
    });
    emit(run, (r) => `Test run ${r.id ?? ""}: ${r.status}${r.error ? `\n${r.error}` : ""}${nextLine(r.next)}`);
    return waitsOnPerson(run) ? EXIT.waiting : EXIT.ok;
  },

  async connections(profile) {
    const out = await call(profile, "listConnections");
    emit(out, (o) => `Saved keys: ${o.secret_names.join(", ") || "none"}\nConnected apps: ${o.providers.length}`);
    return EXIT.ok;
  },

  async connect(profile, a) {
    const body: Record<string, unknown> = { provider: need(a, 0, "an app") };
    if (str(a, "name")) body.name = str(a, "name");
    if (str(a, "automation")) body.automation_id = str(a, "automation");
    const out = await call(profile, "beginConnection", { body, idempotencyKey: randomUUID() });
    emit(out, (o) => (o.already_connected ? `${o.display_name} (${o.name}) is already connected.` : `${o.next?.say ?? ""}\n${o.links?.connect ?? ""}`));
    return waitsOnPerson(out) ? EXIT.waiting : EXIT.ok;
  },

  async apps(profile) {
    const out = await call(profile, "listAppCatalog");
    emit(out, (o) => o.apps.map((x: any) => `${x.id ?? x.slug ?? ""}  ${x.name ?? ""}`).join("\n"));
    return EXIT.ok;
  },

  async docs(profile, a) {
    const topic = a.pos[0];
    if (topic === "runtime") {
      const doc = await call(profile, "getRuntimeDoc", { anonymous: true });
      emit(doc, (d) => d.content);
      return EXIT.ok;
    }
    if (topic === "cli") {
      // The CLI guide is the /docs/cli page as markdown, so it stays current without a CLI release.
      const url = `${authURL()}/docs/cli.md`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { Accept: "text/markdown", "User-Agent": `clickruntime-cli/${VERSION} node` } });
      } catch (e) {
        throw new CliError("network_error", `Could not reach ${url}: ${(e as Error).message}`);
      }
      if (!res.ok) throw new CliError("unavailable", `Could not load the CLI guide (${res.status}). It is also at ${url}`);
      const content = await res.text();
      emit({ topic: "cli", url, content }, (d) => d.content);
      return EXIT.ok;
    }
    throw new CliError("usage", "Usage: clickruntime docs cli|runtime", EXIT.usage);
  },

  async help(_profile, a) {
    const name = a.pos[0];
    if (!name) {
      process.stdout.write(HELP + "\n");
      return EXIT.ok;
    }
    return showHelp(name);
  },

  async issue(profile, a) {
    const sub = need(a, 0, "report, list, show or reply");
    switch (sub) {
      case "report": {
        const body: Record<string, unknown> = { title: needFlag(a, "title"), category: str(a, "category") ?? "other", body: needFlag(a, "body") };
        if (str(a, "automation")) body.automation_id = str(a, "automation");
        if (str(a, "run")) body.run_id = str(a, "run");
        const out = await call(profile, "reportIssue", { body, idempotencyKey: randomUUID() });
        emit(out, (o) => `Reported ${o.id}: ${o.title} (${o.status}).`);
        return EXIT.ok;
      }
      case "list": {
        const out = await call(profile, "listIssues");
        emit(out, (o) => (o.issues.length ? o.issues.map((i: any) => `${i.id}  ${i.status.padEnd(15)}  ${i.title}`).join("\n") : "No issues."));
        return EXIT.ok;
      }
      case "show": {
        const out = await call(profile, "getIssue", { path: { issue_id: need(a, 1, "an issue id") } });
        emit(out, (o) => `${o.title} (${o.status})${(o.messages ?? []).map((m: any) => `\n- ${m.author ?? m.from ?? ""}: ${m.body ?? ""}`).join("")}`);
        return EXIT.ok;
      }
      case "reply": {
        const out = await call(profile, "addIssueMessage", { path: { issue_id: need(a, 1, "an issue id") }, body: { body: needFlag(a, "body") } });
        emit(out, (o) => `Added a message to ${o.id}.`);
        return EXIT.ok;
      }
    }
    throw new CliError("usage", "Usage: clickruntime issue report|list|show|reply", EXIT.usage);
  },
};

function configDirFor(): string {
  // Same rule as client.configDir, kept local to avoid a circular import in the login result.
  if (process.env.CLICKRUNTIME_CONFIG_DIR) return process.env.CLICKRUNTIME_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "clickruntime");
  return join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || process.env.USERPROFILE || ".", ".config"), "clickruntime");
}

const HELP = `ClickRuntime CLI ${VERSION}: run Python automations on a schedule or when an event arrives.

Start with: clickruntime status --json
Sign in:    clickruntime login [--device] [--no-wait]   (the person approves in the browser)
Build:      init <name> --pattern schedule|incoming|remember_then_schedule, save, pull <id>
Setup:      setup <id>, setup run --title t --purpose discover|setup [--file f]
Go live:    deploy <id>, run <id>, resume <id>, delete <id>, wait <ref>, pause <id>
Look:       list, show <id>, runs <id>, run-log <run_id>, events <id>
Events:     replay <id> <event_id>, test-event <id> --file payload.json
Accounts:   connections, connect <app>, apps
Reference:  docs cli (this CLI), docs runtime (writing automation.py)
Support:    issue report|list|show|reply
Options:    --json, --workspace <name>, --version

Help for one command: clickruntime <command> --help
The person signs in, adds keys and connections in the ClickRuntime dashboard, and confirms going live.
Never paste a key into a command. Full guide: clickruntime docs cli`;

/** Help for one command, from help.json. With --json, the topic as an object. */
function showHelp(name: string): number {
  const t = HELP_TOPICS[name];
  if (!t) return fail(new CliError("usage", `Unknown command ${name}. Run clickruntime --help.`, EXIT.usage));
  emit({ command: name, ...t }, () => {
    const out = [t.usage, "", t.summary];
    if (t.details?.length) out.push("", ...t.details);
    if (t.flags?.length) {
      const w = Math.max(...t.flags.map(([f]) => f.length));
      out.push("", "Options:", ...t.flags.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`));
    }
    if (t.output) out.push("", `Output (--json): ${t.output}`);
    if (t.exits) out.push(`Exit codes: ${t.exits}`);
    if (t.next) out.push(`Next: ${t.next}`);
    return out.join("\n");
  });
  return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
  let a: Args;
  try {
    a = parse(argv);
  } catch (e) {
    jsonMode = argv.includes("--json");
    return fail(e);
  }
  jsonMode = a.flags.json === true;
  if (a.flags.version) {
    emit({ version: VERSION }, () => VERSION);
    return EXIT.ok;
  }
  const name = a.pos.shift();
  if (!name) {
    process.stdout.write(HELP + "\n");
    return a.flags.help ? EXIT.ok : EXIT.usage;
  }
  if (a.flags.help && name !== "help") return showHelp(name);
  const cmd = commands[name];
  if (!cmd) return fail(new CliError("usage", `Unknown command ${name}. Run clickruntime --help.`, EXIT.usage));
  const profile = str(a, "workspace") ?? "default";
  try {
    return await cmd(profile, a);
  } catch (e) {
    return fail(e);
  }
}

function fail(e: unknown): number {
  const ce = e instanceof CliError ? e : new CliError("error", (e as Error)?.message ?? String(e));
  if (jsonMode) {
    process.stdout.write(JSON.stringify(ce.toJSON(), null, 2) + "\n");
  } else {
    err(`Error: ${ce.message}${nextLine(ce.next)}`);
  }
  return ce.exit;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
