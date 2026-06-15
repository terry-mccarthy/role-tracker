# CLAUDE.md — Project instructions for Claude Code

## Project overview

This is a personal job search pipeline tool for a senior engineering manager. It uses a Node.js server with a SQLite backend for persistent storage and proxies for AI services. The frontend consists of HTML files in `src/` using vanilla JS with strict compatibility constraints.

## File discovery fallback

When a direct file path returns empty (glob/read fails):
1. Read the parent directory first to discover actual structure
2. Use a broader glob pattern (e.g. `src/**/*.js` instead of `src/pipeline.js`)
3. Never retry the same path — widen the search

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
| `list_jobs` | Returns all pipeline entries (company, role, stage, tier, etc.) |
| `add_job` | Adds a new job to Target List stage. Required: `company`, `role`. Optional: `url`, `source`, `notes`, `tier` (default B). |

## Testing

- **Backend tests**: Run `npm test` to execute SQLite and API tests.
- **Manual testing**:
  1. Start the server: `npm run serve` (local) or `docker compose -f docker-compose.local-ollama.yml up` (Docker)
  2. Open `http://localhost:3000`
  3. Verify CRUD operations: add company, edit, advance stage, delete.
  4. Verify scoring: paste JD, run scorer, check if score is saved to the company card.
  5. Check `pipeline.log` for server-side and proxied frontend logs.
