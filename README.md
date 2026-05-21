# Role Tracker — Senior EM Search System

A personal job search CRM with persistent storage, funnel analytics, and AI-powered role scoring against your evaluation profile.

## Architecture

```
role-tracker/
├── config/
│   ├── evaluation-profile.boilerplate.md # Committed template
│   └── evaluation-profile.md             # Local copy (gitignored, customize this)
├── src/
│   ├── pipeline.html            # Main tracker app (Kanban + Table + Funnel)
│   ├── scorer.html              # Role scorer — paste a JD, get a scored breakdown
│   └── shared.css               # Shared design tokens
├── server.js                    # Node.js server & API proxy
├── database.js                  # SQLite database interface
├── pipeline.db                  # Persistent SQLite database
├── docs/
│   └── scoring-methodology.md   # How the AI scoring works
├── CLAUDE.md                    # Claude Code project instructions
├── package.json                 # Scripts for local dev
└── README.md
```

## Dependencies

### Required
- **Node.js** (v18+) — runs the local server and SQLite backend
- **npm** — package manager (`npm install` fetches `better-sqlite3`)

### AI Scorer (choose one)

#### Option A — Ollama (local, free)
Runs models entirely on your machine. No API key needed.

1. Install Ollama: https://ollama.com
2. Pull a model (recommended):
   ```bash
   ollama pull qwen2.5-coder:32b
   ```
3. Ollama must be running when you use the scorer (`ollama serve` or the desktop app).
4. In the scorer's Settings, select **Ollama (Local)** and enter your model name (e.g. `qwen2.5-coder:32b`).

#### Option B — Anthropic (Claude)
Uses Claude via the Anthropic API (costs money per call).

1. Get an API key at https://console.anthropic.com
2. In the scorer's Settings, select **Anthropic (Claude)** and paste your key.
   > The key is stored in your browser's localStorage — it never leaves your machine.

### URL Extraction (optional)
The scorer can auto-fetch job descriptions from a URL using **Tavily**.

1. Get a free API key at https://tavily.com (free tier is sufficient)
2. Add it to your `.env` file:
   ```
   TAVILY_API_KEY=tvly-...
   ```
   The server reads this from the environment — restart after changes.

## Quick start

```bash
# Install dependencies
npm install
# Create your personal profile (first run only)
cp config/evaluation-profile.boilerplate.md config/evaluation-profile.md

# Start the server (SQLite backend + AI proxies)
npm run serve

# Open in your browser:
# http://localhost:3000
```

## How it works

### Pipeline tracker (`src/pipeline.html`)
- Kanban board with 6 stages: Target → Warming Up → Screen → Interviewing → Offer → Closed
- Table view and funnel analytics with conversion benchmarks
- Persistent storage via SQLite (`pipeline.db`) via the `/api` endpoints
- Local logging and multi-tab synchronization

### Role scorer (`src/scorer.html`)
- Paste a job description or LinkedIn URL content
- AI scores the role against `config/evaluation-profile.md`
- Weighted breakdown across 5 dimensions with traffic-light ratings
- Surfaces tensions (e.g. lifestyle vs growth ambition)
- Score saved to pipeline card if linked

### Evaluation profile (`config/evaluation-profile.md`)
- This file is user-specific and intentionally **not committed** to git
- Start by copying `config/evaluation-profile.boilerplate.md` to `config/evaluation-profile.md`
- **This is the file you edit** to change what matters to you
- Scoring weights, hard nos, compensation floors, lifestyle constraints
- The scorer reads this at runtime — changes take effect immediately

## Developing with Claude Code

This project is designed for iterative development with Claude Code. See `CLAUDE.md` for project-specific instructions.

Common tasks:
```bash
claude "Add a salary range field to the pipeline cards"
claude "Update my evaluation profile — change TC floor to 280k"
claude "Add a new scoring dimension for DEI maturity"
claude "Build a weekly review summary that emails me pipeline stats"
```

Pipeline data is stored in a local SQLite database (`pipeline.db`).
The frontend communicates with the backend via REST APIs defined in `server.js`.
The server also provides proxies for:
- **Ollama**: Local AI scoring (port 11434)
- **Tavily**: External search and content extraction

Backup the `pipeline.db` file regularly.
