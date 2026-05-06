# CLAUDE.md — Project instructions for Claude Code

## Project overview

This is a personal job search pipeline tool for a senior engineering manager. It consists of standalone HTML files with no build step, using vanilla JS with all functions on `window.*` for sandboxed iframe compatibility.

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
- Use `window.storage.get(key)` / `window.storage.set(key, value)` for persistence
- These return Promises — always use `.then()` / `.catch()` (not async/await)
- Fallback: if `window.storage` is unavailable, the app should still work (data just won't persist)
- Storage key for pipeline data: `pipeline-data`
- Storage key for evaluation profile overrides: `eval-profile`

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
| `src/shared.css` | Design tokens (future — currently inlined in each HTML file) |

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

### Changing compensation thresholds
1. Edit `## Compensation` in `evaluation-profile.md`
2. The scorer reads these values dynamically — no code changes needed

### Adding a pipeline field
1. Add the field to the modal form HTML in `pipeline.html`
2. Add it to `window.saveCompany` (both create and edit paths)
3. Add it to `window.renderCard` and/or `window.selectCompany` display
4. It will automatically persist via the existing storage mechanism

## Testing

No test framework. Manual testing:
1. Open the HTML file in a browser
2. Open DevTools console — should be zero errors
3. Test: add company, edit, advance stage, close, delete, export, import
4. Refresh — data should persist
5. For scorer: paste a sample JD, verify score breakdown renders
