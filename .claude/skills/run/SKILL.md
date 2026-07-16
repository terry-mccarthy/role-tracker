---
name: run
description: Launch job-pipeline locally and drive it in a headless browser to verify UI changes. Use when asked to run, start, screenshot, or verify this app.
---

# Running job-pipeline locally

## Dev server

`npm run serve` defaults to port 3000 and `./pipeline.db`. The Docker
`app` container already occupies host port 3002, and Docker does **not**
bind-mount `src/` (only `pipeline.db` and `config/` — see project
CLAUDE.md), so a running container will not reflect uncommitted
frontend changes. Use a scratch port against the real local DB instead:

```bash
PORT=3099 DB_PATH=./pipeline.db npm run serve > /tmp/pipeline-serve.log 2>&1 &
disown
until curl -sf http://localhost:3099/pipeline.html >/dev/null; do sleep 0.5; done
```

Stop when done: `lsof -ti :3099 | xargs kill`

If verifying a change that only exists in `src/mcp/mcp-server-http.js`
or otherwise needs the containerized stack, rebuild instead of relying
on the local server — see "Docker" in the project CLAUDE.md
(`docker compose build mcp && docker compose up -d mcp`, or `app` for
frontend/server changes).

## Driving the UI

**`chromium-cli` is not installed in this environment. Use
`playwright-cli` instead** (Homebrew, `/opt/homebrew/bin/playwright-cli`)
— same headless-browser-REPL idea, different command name/output
format. Don't waste a round-trip checking for `chromium-cli` first.

```bash
playwright-cli open http://localhost:3099/pipeline.html
playwright-cli find "TABLE"          # locate a ref (e.g. e8) by visible text
playwright-cli click e8              # nav tabs (Kanban/Table/Funnel) are JS-driven, not routes — click, don't goto
playwright-cli screenshot --filename=out.png
playwright-cli console error         # check for JS errors before declaring success
playwright-cli close                 # always close the session when done
```

Read the screenshot with the Read tool (image path is relative to cwd).
Delete the screenshot file and the `.playwright-cli/` session directory
afterward — they're scratch artifacts, not meant to be committed.

## Gotchas

- `new Date(null)` in JS is the Unix epoch, not an invalid date — don't
  rely on `isNaN(new Date(x).getTime())` alone to detect missing input;
  check falsy-ness first (see `daysSince` in `src/lib/pipeline.js`).
- Always `lsof -ti :<port> | xargs kill` the scratch server before
  ending the session so it doesn't linger or collide with the next run.
