# CLAUDE.md — Project instructions for Claude Code

## AI Responsibilities
1. Update docs when tests go green.
Before declaring a phase done, update:
README.md — stack section, test count, config table, project layout
CLAUDE.md — any new gotchas, changed startup commands, updated flow description

## Project overview

This is a personal job search pipeline tool for a senior engineering manager. It uses a Node.js server with a SQLite backend for persistent storage and proxies for AI services. The frontend consists of HTML files in `src/` using vanilla JS with strict compatibility constraints.

## Critical constraints

### JavaScript patterns (MUST follow)
- **Top-level state variables must use `var`**: `var companies = [];` — `const`/`let` at the top level of a `<script>` tag do not attach to `window`, so `onclick` handlers can't reach them.
- **Functions callable from inline `onclick` must be on `window`**: either `window.myFunc = function(){}` or a top-level `function myFunc(){}` declaration (both attach to `window` in non-module scripts).
- **Inside function bodies**: `const`/`let`, arrow functions, template literals, destructuring, and optional chaining are all fine.
- **Reason**: Scripts are plain non-module `<script>` tags served by a local Node.js server. The only real constraint is that `const`/`let` at the top level don't go on `window`, so inline handlers can't see them.

### Storage
- Data is persisted in a local SQLite database (`pipeline.db`) via the Node.js backend.
- Frontend uses `fetch()` to call `/api` endpoints:
  - `GET /api/companies`: Retrieve all companies.
  - `POST /api/save`: Create or update a company.
  - `POST /api/delete`: Delete a company.
  - `POST /api/save-score`: Update a company's AI score.
  - `POST /api/kv`: Generic key-value storage (e.g., `nextId`).
  - `POST /api/log`: Write a log entry server-side.
  - `POST /api/migrate`: Bulk import companies.
  - `POST /api/reset`: Wipe all pipeline data.
- `companies.furthest_stage` is a live-updating high-water mark of the deepest real funnel stage (`target`/`warm`/`screen`/`interview`/`offer`) a company has ever reached — including while still open. It exists because `stage` alone loses this once a company closes (`stage` gets overwritten to `'closed'`), but it's kept in sync at every transition, not just at close.
  - The shared, tested primitive is `bumpFurthestStage(current, candidate)` in `src/lib/pipeline.js` — returns the higher-ranked of the two (rank order `target < warm < screen < interview < offer`), ignores `'closed'` as a candidate (it's a terminal status, not a funnel rung), and never regresses. Every place `stage` can change calls this instead of setting `furthest_stage` directly:
    - `createCompanyRecord` — initializes it to the starting stage.
    - `window.advanceStage` / the stage dropdown in the edit modal (`pipeline-app.js`) — bumps it live as a company progresses (or is corrected) through the UI.
    - `closeCompanyRecord` — bumps it from the pre-close `stage` as a safety net (should already be in sync, but this covers drift).
    - MCP `edit_job` (both server variants) — bumps it whenever `fields.stage` is set, so stage changes made via Claude/MCP are tracked too.
    - MCP `add_job` — initializes it to `'target'` (the only stage a new job can start at via that tool).
  - For rows that predate this column, `database.js` runs a one-time startup migration (`migrateFurthestStage`): closed companies get it inferred from `activity` log text ("Advanced to X" / "Closed at X") via `inferFurthestStage` (falls back to `'target'`, which is also correct for jobs that never advanced); open companies just get it copied from their current `stage` (nothing was lost for them).
  - Exposed via MCP in `list_jobs`, `get_job_details`, and `export_pipeline` — unlike `culture_rating`/`culture_notes`, it's cheap (scalar column) so it's included in the slim `list_jobs` summary too, letting a caller get every job's furthest_stage in one lightweight call instead of one `get_job_details` per id.
  - **Gotcha**: `mcp-server-http.js`'s `edit_job`/`fetch_jd` go through the web API's full-row `/api/save` upsert, so any column-backed field (including `furthest_stage`) must be explicitly carried forward in the payload or it gets silently nulled on the next save — mirror whatever `culture_rating`/`culture_notes` do in those functions.
  - **Gotcha**: `export_pipeline`'s *default* response (no `include_jd`) is already ~1.9MB across ~140 jobs, purely from `activity`/`score`/`notes` accumulation — it has no size guard. If you need bulk data cheaply, prefer `list_jobs` (scalars only, ~30KB for the same set) over `export_pipeline`.
- The Table tab's `#closed-summary` bar (built by `computeClosedStats` in `src/lib/pipeline.js`, rendered by `window.renderClosedSummary` in `pipeline-app.js`) breaks down closed companies by `furthest_stage` reached — reuses the `funnel-exit-stage` badge styling from the Funnel tab's closed section for visual consistency. Hides itself (`.closed-summary:empty`) when nothing is closed yet.

### Styling
- Dark theme with CSS custom properties (see `:root` in pipeline.html)
- Fonts: DM Serif Display (headings), DM Mono (labels/code), DM Sans (body)
- Loaded from Google Fonts CDN
- No build tools, no CSS preprocessors

## File responsibilities

| File | Purpose |
|---|---|---|
| `config/evaluation-profile.md` | User's scoring criteria. Editable. Parsed at scoring time. |
| `src/pipeline.html` | Main CRM — kanban, table, funnel views. All pipeline CRUD. |
| `src/scorer.html` | Role evaluation tool. Takes JD text, scores against profile. |
| `src/lib/pipeline.js` | Pipeline data model — record creation, funnel stats, culture parse, activity logging. |
| `src/lib/parse.js` | JD parsing and extraction utilities. |
| `src/lib/scoring.js` | AI scoring bridge — calls external model and processes results. |
| `src/server/server.js` | HTTP server — static files, API routes, proxy endpoints. |
| `src/server/database.js` | SQLite layer — schema, prepared statements, CRUD helpers. |
| `src/mcp/mcp-server.js` | MCP server (stdio) — reads SQLite directly, for local dev. |
| `src/mcp/mcp-server-http.js` | MCP server (HTTP/SSE) — proxies through web API, for Docker. |
| `src/scripts/add-jobs.js` | One-off import script — bulk add roles to the pipeline. |

## Evaluation profile format

The profile in `config/evaluation-profile.md` follows a specific structure:
- Sections with `##` headers map to scoring dimensions
- The `## Scoring weights` table defines dimension weights (must sum to 100%)
- `## Hard nos` defines walk-away criteria (binary pass/fail)
- `## Tensions` are surfaced in every score report
- The scorer parses this file as structured markdown — preserve the heading hierarchy

## Common modifications

### Adding a scoring dimension
1. Add a new `##` section to `evaluation-profile.md` with criteria
2. Add a row to the `## Scoring weights` table (rebalance to 100%)
3. Update `src/scorer.html` scoring logic to include the new dimension

### Adding a pipeline field
1. Add the field to the modal form HTML in `pipeline.html`
2. Add it to `window.saveCompany` (both create and edit paths)
3. Add it to `window.renderCard` and/or `window.selectCompany` display

### Maintaining Docker
1. Keep `docker-compose.local-ollama.yml` and `docker-compose.yml` in sync (same service definitions, only diff is `OLLAMA_HOST`).
2. Both files bind-mount `./pipeline.db:/app/data/pipeline.db` — the database is the local file, not a Docker named volume. Changes made outside Docker (npm run serve, direct SQLite) are immediately visible inside containers.
3. The `mcp` service runs in Docker as an HTTP/SSE server on port 3100, proxying through the app's HTTP API to read/write the database.
4. After rebuilding the Docker image (`docker compose build`), the `mcp` service inside the container must point to the correct server. If `src/mcp/mcp-server-http.js` is updated, rebuild: `docker compose build mcp && docker compose up -d mcp`.

## MCP Server

The project includes two MCP server variants that expose the job pipeline database as AI tools (`list_jobs`, `add_job`).

### Stdio (local development)

Run directly — no web server needed:

```json
"mcpServers": {
  "job-pipeline": {
    "command": "node",
    "args": ["src/mcp/mcp-server.js"],
    "env": {
      "DB_PATH": "/absolute/path/to/pipeline.db"
    }
  }
}
```

The `DB_PATH` env var defaults to `./pipeline.db` relative to the project root.

### Docker

When running via Docker, connect Claude to the MCP container:

```json
"mcpServers": {
  "job-pipeline": {
    "type": "url",
    "url": "http://localhost:3100/sse"
  }
}
```

Start services with: `docker compose -f docker-compose.local-ollama.yml up -d` (or `docker compose up -d` for remote Ollama)

### Tools

| Tool | Description |
|---|---|
| `list_jobs` | Returns a slim summary of all jobs (id, company, role, stage, tier, url, added, furthest_stage). |
| `get_job_details` | Returns full details for one job by id (score, activity, culture notes, furthest_stage). |
| `add_job` | Adds a new job to Target List stage. Required: `company`, `role`. Optional: `url`, `source`, `notes`, `tier` (default B). |
| `edit_job` | Edits fields on an existing job. Required: `id`. Optional: `url`, `role`, `company`, `tier`, `source`, `contact`, `notes`. |
| `fetch_jd` | Fetches the job description from the stored URL via Jina Reader and saves it. Requires `url` set (use `edit_job` first). Run before `score_job`. |
| `score_job` | Scores a job against the evaluation profile using AI. Requires JD stored (run `fetch_jd` first). Optional: `provider` (`anthropic`/`openrouter`), `model`. Stdio server needs `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in env. |
| `export_pipeline` | Exports the full pipeline as structured JSON (all jobs with scores, activity, culture notes, furthest_stage, funnel metadata). Optional: `include_jd` (bool), `include_profile` (bool). JD and profile excluded by default due to size. |

## Testing

- **Backend tests**: Run `npm test` to execute SQLite and API tests.
- **Manual testing**:
  1. Start the server: `npm run serve` (local) or `docker compose -f docker-compose.local-ollama.yml up` (Docker)
  2. Open `http://localhost:3000`
  3. Verify CRUD operations: add company, edit, advance stage, delete.
  4. Verify scoring: paste JD, run scorer, check if score is saved to the company card.
  5. Check `pipeline.log` for server-side and proxied frontend logs.
