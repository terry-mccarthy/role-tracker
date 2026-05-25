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
- **All functions must be assigned to `window`**: `window.myFunc = function() {...}`
- **All state variables must use `var`**: `var companies = [];` (not `const` or `let`)
- **No arrow functions in global scope** — use `function(){}` syntax
- **No template literals** — use string concatenation with `+`
- **No optional chaining** (`?.`) — use explicit null checks
- **No destructuring** — use dot notation
- **Reason**: The app renders in a sandboxed iframe where `const`/`let`/`function` declarations don't attach to `window`. Inline `onclick` handlers need global access.

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
|---|---|
| `config/evaluation-profile.md` | User's scoring criteria. Editable. Parsed at scoring time. |
| `src/pipeline.html` | Main CRM — kanban, table, funnel views. All pipeline CRUD. |
| `src/scorer.html` | Role evaluation tool. Takes JD text, scores against profile. |
| `src/lib/pipeline.js` | Pipeline data model — record creation, funnel stats, culture parse, activity logging. |
| `src/lib/parse.js` | JD parsing and extraction utilities. |
| `src/lib/scoring.js` | AI scoring bridge — calls external model and processes results. |

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
1. Need to keep the docker-compose files in sync. 
2. For local development we use docker-compose.local-ollama.yml 

## Testing

- **Backend tests**: Run `npm test` to execute SQLite and API tests.
- **Manual testing**:
  1. Start the server: `npm run serve` (local) or `docker compose up` (Docker)
  2. Open `http://localhost:3000`
  3. Verify CRUD operations: add company, edit, advance stage, delete.
  4. Verify scoring: paste JD, run scorer, check if score is saved to the company card.
  5. Check `pipeline.log` for server-side and proxied frontend logs.
