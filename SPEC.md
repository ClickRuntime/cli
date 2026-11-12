# ClickRuntime CLI behaviour spec

Both CLIs (`node/`, npm `clickruntime`; `python/`, PyPI `clickruntime-cli`) implement exactly this. The conformance suite in `conformance/` runs the same cases against both.

The CLI is for coding agents. A person only signs in, approves, confirms going live, and adds keys and connections in the ClickRuntime dashboard. The CLI never asks a question, never reads a key, and never confirms on the person's behalf.

## Output

- Results go to stdout; progress and hints go to stderr.
- `--json` prints exactly one JSON object on stdout (pretty-printed with 2 spaces). Errors print `{"error", "message", "next"?, "details"?}` on stdout too.
- Whenever the person must act, the object has `next: {action, url?, say}`. `say` is one sentence the agent can repeat; `url` must be given to the person exactly as printed.
- Tokens are never printed, in either mode.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Error (API error, network error) |
| 2 | Usage error (unknown command, missing argument) |
| 3 | Not signed in, or the sign-in ended (run `clickruntime login`) |
| 4 | Waiting on the person: a link was printed (`next`) |
| 5 | Rate limited (retry after `details.retry_after_seconds` or `RateLimit-Reset`) |
| 6 | The person cancelled the confirmation, or it expired |

## Configuration

| Setting | Default |
|---|---|
| `CLICKRUNTIME_TOKEN` | Access token to use instead of the credentials file (sandboxes, CI). |
| `CLICKRUNTIME_API_URL` | `https://clickruntime.com/api/v1` |
| `CLICKRUNTIME_AUTH_URL` | `https://clickruntime.com` (OAuth issuer: `/oauth/authorize`, `/oauth/token`, `/oauth/device_authorization`) |
| `CLICKRUNTIME_CONFIG_DIR` | `~/.config/clickruntime` (Windows: `%APPDATA%\clickruntime`) |

Credentials file: `<config dir>/credentials.json`, mode 0600:

```json
{"profiles": {"default": {"access_token": "...", "refresh_token": "...", "expires_at": 1767225600, "auth_url": "https://clickruntime.com", "api_url": "https://clickruntime.com/api/v1"}}}
```

`--workspace <name>` picks a profile (default `default`); `login --workspace <name>` writes one. An access token within 60 seconds of `expires_at` is refreshed first (`grant_type=refresh_token`, `client_id=clickruntime-cli`) and the file is rewritten. A pending device sign-in is kept in `<config dir>/pending-<profile>.json` until it finishes.

OAuth client: `client_id=clickruntime-cli` (public, PKCE S256), scope `openid email workspace:read automations:draft automations:control offline_access`, resource `<api url>`.

## Commands

All commands accept `--json` and `--workspace <name>`. Verbs map to MCP tools so skills, MCP and API docs read the same.

| Command | API | MCP tool |
|---|---|---|
| `login [--device] [--no-browser] [--no-wait]` | OAuth loopback, else device grant | — |
| `login --continue` | finish a pending device sign-in | — |
| `logout` | `DELETE /session`, then delete the profile | — |
| `status` | `GET /me` (after refresh) | get_profile |
| `init <name> --pattern schedule\|incoming\|remember_then_schedule` | writes `automation.py` and `clickruntime.json` | — |
| `save [--dir <dir>]` | `POST /automations` or `PATCH /automations/{id}` | save_draft / update_draft / change_automation |
| `pull <id> [--dir <dir>]` | `GET /automations/{id}`, `GET .../script` | get_automation, get_script |
| `list [--status s]` | `GET /automations` (all pages) | list_automations |
| `show <id>` | `GET /automations/{id}` | get_automation |
| `setup <id>` | `GET /automations/{id}/setup` | get_setup_status |
| `setup run --title t --purpose discover\|setup [--file f] [--changes c]` | `POST /setup-runs` | run_setup_script |
| `deploy <id> [--wait]` | `POST /confirmations` (enable, or apply_change when live with a pending change) | prepare_confirmation |
| `run <id> [--wait]` | `POST /confirmations` run_now | prepare_confirmation |
| `resume <id> [--wait]` | `POST /confirmations` resume | prepare_confirmation |
| `delete <id> [--wait]` | `POST /confirmations` delete | prepare_confirmation |
| `wait <confirmation_ref> [--timeout s]` | polls `GET /confirmations/{ref}`; then `GET .../deploy` for enable/apply_change | get_confirmation_status, wait_for_deploy |
| `pause <id>` | `POST /automations/{id}/pause` | pause_automation |
| `runs <id> [--status s] [--limit n]` | `GET /automations/{id}/runs` | list_runs |
| `run-log <run_id> [--wait]` | `GET /runs/{id}` | get_run |
| `events <id>` | `GET /automations/{id}/events` | list_incoming_events |
| `replay <id> <event_id>` | `POST .../events/{event_id}/replay` | replay_event |
| `test-event <id> --file payload.json` | `POST .../test-event` | send_test_event |
| `connections` | `GET /connections` | list_connections |
| `connect <app> [--name n] [--automation id]` | `POST /connections` | begin_connection |
| `apps` | `GET /apps` | list_app_catalog |
| `docs runtime` | `GET /docs/runtime` | resource clickruntime://docs/runtime |
| `docs cli` | `GET <auth_url>/docs/cli.md` (the site, no token) | — |
| `<command> --help`, `help <command>` | none: from `help.json`, embedded at build | — |
| `issue report --title t --category c --body b [--automation id] [--run id]` | `POST /issues` | report_issue |
| `issue list` / `issue show <id>` / `issue reply <id> --body b` | issues routes | list_issues / get_issue / add_issue_message |
| `--version` | prints the version | — |

### Confirm-type commands

`deploy`, `run`, `resume` and `delete` ask the person to confirm. They print the confirm link (`next.url`). With `--json` they return at once with exit 4 unless `--wait` is given; without `--json` they wait by default (`--no-wait` to return). Waiting polls `GET /confirmations/{ref}` every 3 seconds until it is not `pending` (default timeout 600 s, then exit 4). Confirmed: exit 0, and for `deploy`/`resume` the CLI waits for the deploy and prints `{state, confirmation, automation}`. Cancelled or expired: exit 6.

### Login

1. Without `--device`/`--no-browser`: listen on `127.0.0.1:<random>`, open `/oauth/authorize` in the browser (PKCE), and wait up to 120 s for `/callback`. The callback page says "Signed in. You can close this tab and go back to your agent."
2. Otherwise, or if no callback arrives: `POST /oauth/device_authorization`, print `next` (`open_link`, `verification_uri`, never a link with the code in it, "Open <url> and enter <code> to connect ClickRuntime."), and poll `/oauth/token` at `interval` (adding 5 s on `slow_down`) until approved, denied (exit 6) or expired (exit 6).
3. `--no-wait` (device only) prints `next` and exits 4; `login --continue` resumes polling.

### Errors

An API error keeps its `error` code. Exit code: 401 → 3, 429 → 5, everything else → 1. Network failures are `{"error": "network_error"}`, exit 1. Usage errors are `{"error": "usage"}`, exit 2.
