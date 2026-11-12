# ClickRuntime CLI

Run Python automations on a schedule or when an event arrives, from a coding agent in a terminal. The CLI does everything the ClickRuntime MCP server does, with the same rules: the person signs in, adds keys and connections in the ClickRuntime dashboard, and confirms going live. The agent never sees a key and never confirms on its own.

```bash
npx clickruntime status --json
```

or, with Python:

```bash
pipx install clickruntime-cli
clickruntime status --json
```

## For coding agents

1. `clickruntime status --json`. Exit 3 means not signed in.
2. `clickruntime login --device --no-wait --json` prints a link and a code (`next.say`). Give them to the person, then run `clickruntime login --continue`.
3. Read the script reference: `clickruntime docs runtime`. For help with one command run `clickruntime <command> --help`; `clickruntime docs cli` prints the full CLI guide.
4. `clickruntime init "<name>" --pattern schedule`, edit `automation.py` and `clickruntime.json`, then `clickruntime save --json`.
5. `clickruntime setup <id> --json`. Exit 4 means the person has steps to do: give them every `url` exactly as printed.
6. `clickruntime deploy <id> --json` prints a confirm link (exit 4). Give it to the person, then `clickruntime wait <confirmation_ref> --json`.
7. `clickruntime run <id>`, then `clickruntime run-log <run_id> --wait --json` to check the result.

Full command reference: [SPEC.md](SPEC.md) and https://clickruntime.com/docs/cli. The API behind it: https://clickruntime.com/docs/api and https://clickruntime.com/api/v1/openapi.json.

## Exit codes

0 OK · 1 error · 2 usage · 3 not signed in · 4 waiting on the person (a link was printed) · 5 rate limited · 6 cancelled or expired

## Layout

| Path | What |
|---|---|
| `SPEC.md` | The behaviour both CLIs implement |
| `openapi.json` | The API spec, copied from the ClickRuntime backend |
| `scripts/generate.mjs` | Generates the typed clients from `openapi.json` |
| `node/` | npm package `clickruntime` (TypeScript, no runtime dependencies) |
| `python/` | PyPI package `clickruntime-cli` (standard library only; installs `clickruntime_cli`, never a `clickruntime` module) |
| `conformance/` | Shared cases run against both CLIs with a mock API |

## Develop

```bash
node scripts/generate.mjs
cd node && npm install && npm run build && cd ..
node conformance/run.mjs all
```


## License

MIT
