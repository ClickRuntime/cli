"""ClickRuntime CLI. Behaviour: ../../SPEC.md (shared with the Node CLI, checked by conformance/)."""
import json
import os
import sys
import time
import uuid

import urllib.error
import urllib.request

from .client import (SIGN_IN_NEXT, VERSION, CliError, Exit, api_url, auth_url, call, config_dir, delete_profile,
                     read_credentials)
from .generated import HELP_TOPICS
from .login import login as do_login

BOOL_FLAGS = {"json", "wait", "no-wait", "device", "no-browser", "continue", "help", "version"}
POLL_S = float(os.environ.get("CLICKRUNTIME_POLL_MS", "3000")) / 1000

_json_mode = False


class Args:
    def __init__(self):
        self.pos = []
        self.flags = {}

    def str(self, k):
        v = self.flags.get(k)
        return v if isinstance(v, str) else None

    def need(self, i, what):
        if i >= len(self.pos) or not self.pos[i]:
            raise CliError("usage", "Missing %s. Run clickruntime --help." % what, Exit.USAGE)
        return self.pos[i]

    def need_flag(self, k):
        v = self.str(k)
        if not v:
            raise CliError("usage", "Missing --%s." % k, Exit.USAGE)
        return v


def parse(argv):
    a = Args()
    i = 0
    while i < len(argv):
        x = argv[i]
        if x == "--":
            a.pos.extend(argv[i + 1:])
            break
        if x.startswith("--"):
            k, eq, v = x[2:].partition("=")
            if eq:
                a.flags[k] = v
            elif k in BOOL_FLAGS:
                a.flags[k] = True
            elif i + 1 < len(argv):
                i += 1
                a.flags[k] = argv[i]
            else:
                raise CliError("usage", "--%s needs a value." % k, Exit.USAGE)
        elif x == "-h":
            a.flags["help"] = True
        else:
            a.pos.append(x)
        i += 1
    return a


def err(s):
    sys.stderr.write(s + "\n")
    sys.stderr.flush()


def emit(obj, human=None):
    if _json_mode or human is None:
        sys.stdout.write(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(human(obj) + "\n")
    sys.stdout.flush()


def next_line(n):
    if not n:
        return ""
    out = "\nNext: " + n.get("say", "")
    if n.get("url") and n["url"] not in n.get("say", ""):
        out += "\n" + n["url"]
    return out


def waits_on_person(o):
    return bool(o and (o.get("next") or {}).get("action") == "open_link")


# ---- local project files ----

TEMPLATES = {
    "schedule": '''from clickruntime import on_trigger, log


@on_trigger
def run(event):
    # Runs on the schedule in clickruntime.json. Read the script reference first:
    # clickruntime docs runtime
    log("running")
    return {"ok": True}
''',
    "incoming": '''from clickruntime import on_event, log


@on_event
def handle(event):
    # Runs for each event sent to the trigger link. event.body is the JSON payload.
    log("got", event.event_id)
    return {"seen": True}
''',
    "remember_then_schedule": '''from clickruntime import on_trigger, state, log


@on_trigger
def run(event):
    # Runs on the schedule and keeps what it saw in state between runs.
    seen = state.get("seen", [])
    log("seen so far", len(seen))
    return {"ok": True}
''',
}


def project_paths(d):
    return os.path.join(d, "clickruntime.json"), os.path.join(d, "automation.py")


def read_project(d):
    cfg_path, script_path = project_paths(d)
    if not os.path.exists(cfg_path):
        raise CliError("usage", "No clickruntime.json in %s. Run clickruntime init <name> first." % d, Exit.USAGE)
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except ValueError:
        raise CliError("usage", "clickruntime.json is not valid JSON.", Exit.USAGE)
    if not os.path.exists(script_path):
        raise CliError("usage", "No automation.py in %s." % d, Exit.USAGE)
    with open(script_path, encoding="utf-8") as f:
        cfg["script"] = f.read()
    return cfg


def write_project(d, cfg, script=None):
    cfg_path, script_path = project_paths(d)
    os.makedirs(d, exist_ok=True)
    rest = {k: v for k, v in cfg.items() if k != "script"}
    with open(cfg_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(rest, indent=2, ensure_ascii=False) + "\n")
    if script is not None:
        with open(script_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(script)


# ---- confirmations ----

def confirm_and_wait(profile, a, automation_id, action):
    conf = call(profile, "prepareConfirmation", body={"automation_id": automation_id, "action": action}, idempotency_key=str(uuid.uuid4()))
    wait = a.flags.get("wait") is True or (not _json_mode and a.flags.get("no-wait") is not True)
    if not wait:
        emit(conf, lambda c: "%s: %s%s" % (c.get("name"), c.get("effect") or action, next_line(c.get("next"))))
        return Exit.WAITING
    if not _json_mode:
        err("%s\n%s\nWaiting for you to confirm…" % ((conf.get("next") or {}).get("say", "Open the link to confirm."), (conf.get("links") or {}).get("confirm", "")))
    return wait_for(profile, conf["confirmation_ref"], float(a.str("timeout") or 600))


def wait_for(profile, ref, timeout_s):
    until = time.time() + timeout_s
    while True:
        st = call(profile, "getConfirmationStatus", path={"confirmation_ref": ref})
        state = st.get("state")
        if state in ("confirmed", "used"):
            automation = None
            if st.get("action") in ("enable", "apply_change", "resume") and not st.get("deleted"):
                try:
                    automation = call(profile, "waitForDeploy", path={"automation_id": st["automation_id"]})
                except CliError as e:
                    if e.code != "not_deployed":
                        raise
            emit({"state": "confirmed", "confirmation": st, "automation": automation},
                 lambda o: "Confirmed: %s %s." % (st.get("action"), st.get("name")))
            return Exit.OK
        if state in ("cancelled", "expired"):
            raise CliError(
                "confirmation_cancelled" if state == "cancelled" else "confirmation_expired",
                "The person cancelled it." if state == "cancelled" else "The confirmation expired before the person confirmed.",
                Exit.CANCELLED,
            )
        if time.time() > until:
            emit(st, lambda o: "Still waiting for the person to confirm. Run clickruntime wait %s to keep waiting." % ref)
            return Exit.WAITING
        time.sleep(POLL_S)


# ---- commands ----

def cmd_login(profile, a):
    no_wait = a.flags.get("no-wait") is True

    def announce(nxt, code):
        if _json_mode and no_wait:
            return
        if _json_mode:
            sys.stdout.write(json.dumps({"state": "waiting", "user_code": code, "next": nxt}, separators=(",", ":"), ensure_ascii=False) + "\n")
            sys.stdout.flush()
        else:
            err("%s\nWaiting for you to approve…" % nxt["say"])

    result = do_login(profile, a.flags.get("device") is True, a.flags.get("no-browser") is True, no_wait,
                      a.flags.get("continue") is True, announce, lambda s: None if _json_mode else err(s))
    if result == "waiting":
        with open(os.path.join(config_dir(), "pending-%s.json" % profile), encoding="utf-8") as f:
            pending = json.load(f)
        emit({
            "state": "waiting",
            "user_code": pending["user_code"],
            "next": {
                "action": "open_link",
                # A pending file from an older CLI may hold verification_uri_complete; drop its ?code=.
                "url": (pending.get("verification_uri") or pending.get("verification_uri_complete") or "").split("?")[0],
                "say": "Open %s and enter %s to connect ClickRuntime." % (
                    (pending.get("verification_uri") or pending.get("verification_uri_complete") or "").split("?")[0], pending["user_code"]),
            },
        }, lambda o: "%s\nThen run: clickruntime login --continue" % o["next"]["say"])
        return Exit.WAITING
    me = call(profile, "getProfile")
    emit({"signed_in": True, "email": me.get("email"), "profile": profile}, lambda o: "Signed in as %s." % o["email"])
    return Exit.OK


def cmd_logout(profile, a):
    had = profile in read_credentials()["profiles"]
    if had:
        try:
            call(profile, "signOut")
        except CliError as e:
            if e.exit != Exit.SIGNED_OUT:
                raise
        delete_profile(profile)
    emit({"signed_out": True}, lambda o: "Signed out." if had else "Not signed in.")
    return Exit.OK


def cmd_status(profile, a):
    env = bool(os.environ.get("CLICKRUNTIME_TOKEN"))
    if not env and profile not in read_credentials()["profiles"]:
        emit({"signed_in": False, "api_url": api_url(), "next": SIGN_IN_NEXT}, lambda o: "Not signed in. Run: clickruntime login")
        return Exit.SIGNED_OUT
    try:
        me = call(profile, "getProfile")
    except CliError as e:
        if e.exit == Exit.SIGNED_OUT:
            emit({"signed_in": False, "api_url": api_url(), "next": SIGN_IN_NEXT}, lambda o: "The sign-in ended. Run: clickruntime login")
            return Exit.SIGNED_OUT
        raise
    emit({"signed_in": True, "email": me.get("email"), "profile_id": me.get("id"), "workspace_profile": profile, "api_url": api_url(),
          "token_source": "env" if env else "file"},
         lambda o: "Signed in as %s (%s)." % (o["email"], o["workspace_profile"]))
    return Exit.OK


def cmd_init(profile, a):
    name = a.need(0, "a name")
    pattern = a.str("pattern") or "schedule"
    if pattern not in TEMPLATES:
        raise CliError("usage", "--pattern must be schedule, incoming or remember_then_schedule.", Exit.USAGE)
    d = a.str("dir") or "."
    cfg_path, script_path = project_paths(d)
    if os.path.exists(cfg_path) or os.path.exists(script_path):
        raise CliError("usage", "%s already has clickruntime.json or automation.py." % d, Exit.USAGE)
    cfg = {"name": name, "summary": "", "pattern": pattern}
    if pattern != "incoming":
        cfg["schedule"] = {"kind": "hourly"}
    cfg.update({"how_it_works": {"steps": []}, "setup_needs": [], "dependencies": []})
    write_project(d, cfg, TEMPLATES[pattern])
    emit({"created": [cfg_path, script_path]},
         lambda o: "Wrote %s and %s. Fill in summary and how_it_works, then: clickruntime save" % (cfg_path, script_path))
    return Exit.OK


def cmd_save(profile, a):
    d = a.str("dir") or "."
    cfg = read_project(d)
    body = {f: cfg[f] for f in ("name", "summary", "schedule", "how_it_works", "setup_needs", "dependencies", "retry", "signature", "script") if f in cfg}
    if cfg.get("automation_id"):
        saved = call(profile, "updateAutomation", path={"automation_id": cfg["automation_id"]}, body=body)
    else:
        body["pattern"] = cfg.get("pattern")
        saved = call(profile, "saveDraft", body=body, idempotency_key=str(uuid.uuid4()))
        cfg["automation_id"] = saved["automation_id"]
        write_project(d, cfg)
    emit(saved, lambda s: "Saved %s (%s), %s.%s%s" % (s.get("name"), s.get("automation_id"), s.get("status"),
                                                       "".join("\nNote: " + n for n in s.get("notes") or []), next_line(s.get("next"))))
    return Exit.OK


def cmd_pull(profile, a):
    aid = a.need(0, "an automation id")
    d = a.str("dir") or "."
    aut = call(profile, "getAutomation", path={"automation_id": aid})
    script = call(profile, "getScript", path={"automation_id": aid})
    cfg = {"automation_id": aut["automation_id"], "name": aut.get("name"), "summary": aut.get("summary"), "pattern": aut.get("pattern")}
    if (aut.get("schedule") or {}).get("spec"):
        cfg["schedule"] = aut["schedule"]["spec"]
    cfg.update({"how_it_works": aut.get("how_it_works") or {"steps": []}, "setup_needs": [], "dependencies": aut.get("dependencies") or []})
    if aut.get("retry"):
        cfg["retry"] = aut["retry"]
    write_project(d, cfg, script.get("code", ""))
    emit({"automation_id": aid, "dir": d, "redacted": script.get("redacted")},
         lambda o: "Wrote %s/clickruntime.json and %s/automation.py. Check setup_needs before saving." % (d, d))
    return Exit.OK


def cmd_list(profile, a):
    items, cursor, total = [], None, 0
    while True:
        page = call(profile, "listAutomations", query={"status": a.str("status"), "cursor": cursor, "limit": 50})
        items.extend(page.get("automations") or [])
        total = page.get("total", 0)
        cursor = page.get("next_cursor")
        if not cursor:
            break
    emit({"automations": items, "total": total},
         lambda o: "\n".join("%s  %-6s  %s" % (x["automation_id"], x["status"], x["name"]) for x in o["automations"]) or "No automations yet.")
    return Exit.OK


def cmd_show(profile, a):
    aut = call(profile, "getAutomation", path={"automation_id": a.need(0, "an automation id")})

    def human(x):
        out = "%s (%s): %s\n%s" % (x.get("name"), x.get("automation_id"), x.get("status"), x.get("summary"))
        if x.get("schedule"):
            out += "\n" + x["schedule"].get("description", "")
        if x.get("trigger"):
            out += "\nTrigger link: " + x["trigger"].get("url", "")
        return out + next_line(x.get("next"))

    emit(aut, human)
    return Exit.OK


def _log_lines(logs):
    return "".join("\n" + (l if isinstance(l, str) else json.dumps(l)) for l in logs or [])


def cmd_setup(profile, a):
    if a.pos and a.pos[0] == "run":
        f = a.str("file") or "automation.py"
        if not os.path.exists(f):
            raise CliError("usage", "No %s." % f, Exit.USAGE)
        with open(f, encoding="utf-8") as fh:
            script = fh.read()
        body = {"title": a.need_flag("title"), "purpose": a.str("purpose") or "discover", "script": script, "setup_needs": []}
        if os.path.exists("clickruntime.json"):
            with open("clickruntime.json", encoding="utf-8") as fh:
                cfg = json.load(fh)
            body["setup_needs"] = cfg.get("setup_needs") or []
            if cfg.get("dependencies"):
                body["dependencies"] = cfg["dependencies"]
        if a.str("changes"):
            body["changes"] = a.str("changes")
        run = call(profile, "runSetupScript", body=body, idempotency_key=str(uuid.uuid4()))
        emit(run, lambda r: "Setup run %s: %s%s%s" % (r.get("setup_run_id"), r.get("status"), "\n" + r["error"] if r.get("error") else "", _log_lines(r.get("logs"))))
        return Exit.ERROR if run.get("status") in ("failed", "timed_out") else Exit.OK
    st = call(profile, "getSetupStatus", path={"automation_id": a.need(0, "an automation id")})

    def human(s):
        if s.get("ready"):
            return "%s: setup is complete." % s.get("name")
        items = "\n".join("- %s%s" % (i.get("name"), ": " + i["url"] if i.get("url") else "") for i in s.get("items") or [] if not i.get("ready"))
        return "%s: %d setup step(s) left:\n%s%s" % (s.get("name"), len(s.get("steps") or []), items, next_line(s.get("next")))

    emit(st, human)
    return Exit.WAITING if waits_on_person(st) else Exit.OK


def cmd_deploy(profile, a):
    aid = a.need(0, "an automation id")
    aut = call(profile, "getAutomation", path={"automation_id": aid})
    status = aut.get("status")
    action = "enable" if status == "draft" else "apply_change" if aut.get("pending_change") else "resume" if status == "paused" else ""
    if not action:
        raise CliError("nothing_to_deploy", "It is already live and has no pending change. Change it with clickruntime save first.", Exit.ERROR)
    return confirm_and_wait(profile, a, aid, action)


def cmd_pause(profile, a):
    aut = call(profile, "pauseAutomation", path={"automation_id": a.need(0, "an automation id")})
    emit(aut, lambda x: "%s is %s." % (x.get("name"), x.get("status")))
    return Exit.OK


def cmd_runs(profile, a):
    out = call(profile, "listRuns", path={"automation_id": a.need(0, "an automation id")},
               query={"status": a.str("status"), "limit": int(a.str("limit")) if a.str("limit") else None})
    emit(out, lambda o: "\n".join("%s  %-9s  %s  %s" % (r["id"], r["status"], r.get("created_at"), r.get("trigger")) for r in o["runs"]) or "No runs yet.")
    return Exit.OK


def cmd_run_log(profile, a):
    run = call(profile, "getRun", path={"run_id": a.need(0, "a run id")}, query={"wait": True if a.flags.get("wait") is True else None})
    emit(run, lambda r: "%s: %s%s%s" % (r.get("id"), r.get("status"), "\nError: " + r["error"] if r.get("error") else "", _log_lines(r.get("logs"))))
    return Exit.OK


def cmd_events(profile, a):
    out = call(profile, "listIncomingEvents", path={"automation_id": a.need(0, "an automation id")})
    emit(out, lambda o: "\n".join("%s  %s" % (e.get("id") or e.get("event_id"), e.get("received_at") or "") for e in o["events"]) or "No events yet.")
    return Exit.OK


def cmd_replay(profile, a):
    run = call(profile, "replayEvent", path={"automation_id": a.need(0, "an automation id"), "event_id": a.need(1, "an event id")},
               idempotency_key=str(uuid.uuid4()))
    emit(run, lambda r: "Run %s: %s%s" % (r.get("id"), r.get("status"), "\n" + r["error"] if r.get("error") else ""))
    return Exit.OK


def cmd_test_event(profile, a):
    f = a.need_flag("file")
    try:
        with open(f, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        raise CliError("usage", "%s is not valid JSON." % f, Exit.USAGE)
    run = call(profile, "sendTestEvent", path={"automation_id": a.need(0, "an automation id")}, body={"body": payload},
               idempotency_key=str(uuid.uuid4()))
    emit(run, lambda r: "Test run %s: %s%s%s" % (r.get("id") or "", r.get("status"), "\n" + r["error"] if r.get("error") else "", next_line(r.get("next"))))
    return Exit.WAITING if waits_on_person(run) else Exit.OK


def cmd_connections(profile, a):
    out = call(profile, "listConnections")
    emit(out, lambda o: "Saved keys: %s\nConnected apps: %d" % (", ".join(o.get("secret_names") or []) or "none", len(o.get("providers") or [])))
    return Exit.OK


def cmd_connect(profile, a):
    body = {"provider": a.need(0, "an app")}
    if a.str("name"):
        body["name"] = a.str("name")
    if a.str("automation"):
        body["automation_id"] = a.str("automation")
    out = call(profile, "beginConnection", body=body, idempotency_key=str(uuid.uuid4()))
    emit(out, lambda o: "%s (%s) is already connected." % (o.get("display_name"), o.get("name")) if o.get("already_connected")
         else "%s\n%s" % ((o.get("next") or {}).get("say", ""), (o.get("links") or {}).get("connect", "")))
    return Exit.WAITING if waits_on_person(out) else Exit.OK


def cmd_apps(profile, a):
    out = call(profile, "listAppCatalog")
    emit(out, lambda o: "\n".join("%s  %s" % (x.get("id") or x.get("slug") or "", x.get("name") or "") for x in o.get("apps") or []))
    return Exit.OK


def cmd_docs(profile, a):
    topic = a.pos[0] if a.pos else None
    if topic == "runtime":
        doc = call(profile, "getRuntimeDoc", anonymous=True)
        emit(doc, lambda d: d.get("content", ""))
        return Exit.OK
    if topic == "cli":
        # The CLI guide is the /docs/cli page as markdown, so it stays current without a CLI release.
        url = auth_url() + "/docs/cli.md"
        req = urllib.request.Request(url, headers={"Accept": "text/markdown", "User-Agent": "clickruntime-cli/%s python" % VERSION})
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                content = res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raise CliError("unavailable", "Could not load the CLI guide (%d). It is also at %s" % (e.code, url))
        except (urllib.error.URLError, OSError) as e:
            raise CliError("network_error", "Could not reach %s: %s" % (url, getattr(e, "reason", e)))
        emit({"topic": "cli", "url": url, "content": content}, lambda d: d["content"])
        return Exit.OK
    raise CliError("usage", "Usage: clickruntime docs cli|runtime", Exit.USAGE)


def cmd_help(profile, a):
    if not a.pos:
        sys.stdout.write(HELP + "\n")
        return Exit.OK
    return _show_help(a.pos[0])


def cmd_issue(profile, a):
    sub = a.need(0, "report, list, show or reply")
    if sub == "report":
        body = {"title": a.need_flag("title"), "category": a.str("category") or "other", "body": a.need_flag("body")}
        if a.str("automation"):
            body["automation_id"] = a.str("automation")
        if a.str("run"):
            body["run_id"] = a.str("run")
        out = call(profile, "reportIssue", body=body, idempotency_key=str(uuid.uuid4()))
        emit(out, lambda o: "Reported %s: %s (%s)." % (o.get("id"), o.get("title"), o.get("status")))
        return Exit.OK
    if sub == "list":
        out = call(profile, "listIssues")
        emit(out, lambda o: "\n".join("%s  %-15s  %s" % (i["id"], i["status"], i["title"]) for i in o.get("issues") or []) or "No issues.")
        return Exit.OK
    if sub == "show":
        out = call(profile, "getIssue", path={"issue_id": a.need(1, "an issue id")})
        emit(out, lambda o: "%s (%s)%s" % (o.get("title"), o.get("status"),
                                          "".join("\n- %s: %s" % (m.get("author") or m.get("from") or "", m.get("body") or "") for m in o.get("messages") or [])))
        return Exit.OK
    if sub == "reply":
        out = call(profile, "addIssueMessage", path={"issue_id": a.need(1, "an issue id")}, body={"body": a.need_flag("body")})
        emit(out, lambda o: "Added a message to %s." % o.get("id"))
        return Exit.OK
    raise CliError("usage", "Usage: clickruntime issue report|list|show|reply", Exit.USAGE)


COMMANDS = {
    "login": cmd_login, "logout": cmd_logout, "status": cmd_status, "init": cmd_init, "save": cmd_save, "pull": cmd_pull,
    "list": cmd_list, "show": cmd_show, "setup": cmd_setup, "deploy": cmd_deploy,
    "run": lambda p, a: confirm_and_wait(p, a, a.need(0, "an automation id"), "run_now"),
    "resume": lambda p, a: confirm_and_wait(p, a, a.need(0, "an automation id"), "resume"),
    "delete": lambda p, a: confirm_and_wait(p, a, a.need(0, "an automation id"), "delete"),
    "wait": lambda p, a: wait_for(p, a.need(0, "a confirmation_ref"), float(a.str("timeout") or 600)),
    "pause": cmd_pause, "runs": cmd_runs, "run-log": cmd_run_log, "events": cmd_events, "replay": cmd_replay,
    "test-event": cmd_test_event, "connections": cmd_connections, "connect": cmd_connect, "apps": cmd_apps,
    "docs": cmd_docs, "issue": cmd_issue, "help": cmd_help,
}

HELP = """ClickRuntime CLI %s: run Python automations on a schedule or when an event arrives.

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
Never paste a key into a command. Full guide: clickruntime docs cli""" % VERSION


def _show_help(name):
    """Help for one command, from help.json. With --json, the topic as an object."""
    t = HELP_TOPICS.get(name)
    if not t:
        return _fail(CliError("usage", "Unknown command %s. Run clickruntime --help." % name, Exit.USAGE))

    def text(_):
        out = [t["usage"], "", t["summary"]]
        if t.get("details"):
            out += [""] + t["details"]
        if t.get("flags"):
            w = max(len(f) for f, _ in t["flags"])
            out += ["", "Options:"] + ["  %s  %s" % (f.ljust(w), d) for f, d in t["flags"]]
        if t.get("output"):
            out += ["", "Output (--json): " + t["output"]]
        if t.get("exits"):
            out.append("Exit codes: " + t["exits"])
        if t.get("next"):
            out.append("Next: " + t["next"])
        return "\n".join(out)

    emit(dict({"command": name}, **t), text)
    return Exit.OK


def _fail(e):
    ce = e if isinstance(e, CliError) else CliError("error", str(e))
    if _json_mode:
        sys.stdout.write(json.dumps(ce.to_json(), indent=2, ensure_ascii=False) + "\n")
    else:
        err("Error: %s%s" % (ce.message, next_line(ce.next)))
    return ce.exit


def main(argv):
    global _json_mode
    try:
        a = parse(argv)
    except CliError as e:
        _json_mode = "--json" in argv
        return _fail(e)
    _json_mode = a.flags.get("json") is True
    if a.flags.get("version"):
        emit({"version": VERSION}, lambda o: VERSION)
        return Exit.OK
    name = a.pos.pop(0) if a.pos else None
    if not name:
        sys.stdout.write(HELP + "\n")
        return Exit.OK if a.flags.get("help") else Exit.USAGE
    if a.flags.get("help") and name != "help":
        return _show_help(name)
    cmd = COMMANDS.get(name)
    if not cmd:
        return _fail(CliError("usage", "Unknown command %s. Run clickruntime --help." % name, Exit.USAGE))
    profile = a.str("workspace") or "default"
    try:
        return cmd(profile, a)
    except KeyboardInterrupt:
        return Exit.ERROR
    except Exception as e:  # noqa: BLE001 - every failure is printed in the shared error shape
        return _fail(e)


def run():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass
    sys.exit(main(sys.argv[1:]))


if __name__ == "__main__":
    run()
