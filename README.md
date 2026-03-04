# flutterflow-mcp (Beast Mode)

`flutterflow-mcp` is a FlutterFlow MCP server built around a command-palette model — forked and enhanced with **beast mode** for full custom code access and unrestricted editing.

## Prerequisites

### Required

| Requirement | Version | Check |
|---|---|---|
| **Node.js** | 18+ (tested on 24.x) | `node --version` |
| **npm** | 9+ | `npm --version` |
| **Git** | Any recent | `git --version` |
| **FlutterFlow API Token** | v2 token from your FF account | [FlutterFlow Settings → API Tokens](https://app.flutterflow.io/) |

### Required for AI Editor Integration

You need an **MCP-compatible editor** — at least one of:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- [Claude Desktop](https://claude.ai/download)
- [Cursor](https://cursor.sh/)
- [Windsurf](https://codeium.com/windsurf)
- [Codex](https://github.com/openai/codex) (CLI/App)

### Optional

- **FlutterFlow project** to test against (any project your API token can access)
- **Fly.io account** for remote deployment

---

## Setup (Fresh Install)

### TL;DR (5 commands)

```bash
git clone https://github.com/mylestech-solutions/flutterflow-mcp.git
cd flutterflow-mcp && git checkout beast-mode
npm install && npm run build
# Then add the MCP config to your editor (see step 3 below)
```

### 1) Clone and Build

```bash
git clone https://github.com/mylestech-solutions/flutterflow-mcp.git
cd flutterflow-mcp
git checkout beast-mode
npm install
npm run build
```

> **Windows/Linux note**: `better-sqlite3` is a native module. If `npm install` fails, you may need:
> - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
> - **Windows**: `npm install --global windows-build-tools` or install Visual Studio Build Tools + Python 3
> - **Linux**: `sudo apt-get install build-essential python3` (Debian/Ubuntu)

### 2) Get Your FlutterFlow API Token

1. Log in to [FlutterFlow](https://app.flutterflow.io/)
2. Go to **Settings → API Tokens**
3. Create or copy your token

### 3) Configure Your Editor

Pick your editor below and add the MCP server config.

#### Claude Code (`.mcp.json` in your project root)

Create or edit `.mcp.json` in the root of the project you want to use Orbit from:

```json
{
  "mcpServers": {
    "flutterflow-orbit": {
      "command": "node",
      "args": ["/absolute/path/to/flutterflow-mcp/dist/main.js"],
      "env": {
        "FLUTTERFLOW_API_TOKEN": "YOUR_TOKEN_HERE",
        "FLUTTERFLOW_API_MIN_INTERVAL_MS": "1000",
        "ORBIT_POLICY_SAFE_MODE": "fullWrite",
        "ORBIT_ALLOW_POLICY_WRITE": "1",
        "ORBIT_HTTP_ENABLED": "0"
      }
    }
  }
}
```

Or add via CLI:

```bash
claude mcp add -s project \
  -e FLUTTERFLOW_API_TOKEN=YOUR_TOKEN \
  -e FLUTTERFLOW_API_MIN_INTERVAL_MS=1000 \
  -e ORBIT_POLICY_SAFE_MODE=fullWrite \
  -e ORBIT_ALLOW_POLICY_WRITE=1 \
  -e ORBIT_HTTP_ENABLED=0 \
  flutterflow-orbit -- node /absolute/path/to/flutterflow-mcp/dist/main.js
```

#### Cursor / Windsurf / Claude Desktop

Add to your MCP settings (usually `~/.cursor/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "flutterflow-orbit": {
      "command": "node",
      "args": ["/absolute/path/to/flutterflow-mcp/dist/main.js"],
      "env": {
        "FLUTTERFLOW_API_TOKEN": "YOUR_TOKEN_HERE",
        "FLUTTERFLOW_API_MIN_INTERVAL_MS": "1000",
        "ORBIT_POLICY_SAFE_MODE": "fullWrite",
        "ORBIT_ALLOW_POLICY_WRITE": "1",
        "ORBIT_HTTP_ENABLED": "0"
      }
    }
  }
}
```

#### Codex (CLI / App)

```bash
codex mcp add flutterflow-orbit \
  --env FLUTTERFLOW_API_TOKEN=YOUR_TOKEN \
  --env ORBIT_POLICY_SAFE_MODE=fullWrite \
  --env ORBIT_ALLOW_POLICY_WRITE=1 \
  -- node /absolute/path/to/flutterflow-mcp/dist/main.js
```

### 4) Verify

Restart your editor, then test:

```
orbit({ cmd: "help" })
orbit({ cmd: "api.capabilities" })
```

If both return `ok: true`, you're good.

---

## Beast Mode (This Fork)

This fork removes hard-coded restrictions from the upstream Orbit server:

| Change | What It Does |
|---|---|
| **Custom code unlocked** | `lib/custom_code/`, `lib/custom_functions/`, `lib/main.dart` are now editable |
| **Risk score reduced** | Custom code edits score +5 (awareness) instead of +40 (blocking) |
| **Default policy: fullWrite** | No file deny prefixes, 500 files/apply, 50k lines max, platform config edits enabled |

The `orbit.policy.json` file ships with beast mode defaults. You can tighten it for production use.

---

## What Orbit Is

Orbit is different from multi-tool MCP servers by design:

- One primary tool: `orbit`
- Command palette verbs inside `cmd` (`help`, `snapshots.create`, `changeset.apply`, etc.)
- SQLite snapshot cache with persisted indices/graphs
- Policy engine (`orbit.policy.json` + env overrides)
- Transactional ChangeSet flow: `new -> add -> preview -> validate -> apply`

## Features

- Node.js 18+ TypeScript strict implementation
- MCP stdio transport for Claude Desktop/Cursor/Windsurf/Claude Code/Codex
- Separate HTTP health/status/policy service on port `8080`
- FlutterFlow API adapter (set `FLUTTERFLOW_API_TOKEN` for remote reads/writes)
- SQLite snapshot store (files, hashes, symbols, edges)
- Navigation + component usage graph index
- Safe editing policy engine with manual-approval mode
- Orbit schema pack resources:
  - `orbit://schema/index`
  - `orbit://schema/doc/{id}`
  - `orbit://schema/snippet/{id}`

## Quick Start

### 1) Install

```bash
npm i
```

### 2) Configure env (optional for local startup)

```bash
export FLUTTERFLOW_API_TOKEN=your_token_here
```

Without a token, the MCP server still starts, but commands that call FlutterFlow APIs (for example `projects.list`, `snapshots.create`, `snapshots.refresh`) will return a missing-token error until you set it.

Optional API path overrides:

```bash
export FLUTTERFLOW_API_BASE_URL=https://api.flutterflow.io/v2
export FLUTTERFLOW_API_LIST_PROJECTS_PATH=/l/listProjects
export FLUTTERFLOW_API_LIST_PARTITIONED_FILES_PATH=/listPartitionedFileNames
export FLUTTERFLOW_API_PROJECT_YAMLS_PATH=/projectYamls
export FLUTTERFLOW_API_VALIDATE_PROJECT_YAML_PATH=/validateProjectYaml
export FLUTTERFLOW_API_UPDATE_PROJECT_YAML_PATH=/updateProjectByYaml
export FLUTTERFLOW_API_MIN_INTERVAL_MS=1000
```

### 3) Run

```bash
npm start
```

This starts:

- MCP server over stdio
- HTTP server on `http://localhost:8080`

Endpoints:

- `GET /health`
- `GET /status`
- `GET /policy`

If the HTTP port is already in use, Orbit now continues with MCP stdio and logs a warning to stderr.
You can disable HTTP endpoints entirely with:

```bash
export ORBIT_HTTP_ENABLED=0
```

## MCP Client Setup

Use `npm start` as your MCP command.

### Claude Desktop / Cursor / Windsurf

Use `templates/mcp-config.local.json` as a base:

```json
{
  "mcpServers": {
    "ff_orbit_mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/absolute/path/to/ff-mcp",
      "env": {
        "FLUTTERFLOW_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Code

Use project config file `.mcp.json` (you can copy `templates/claude-code.mcp.json`):

```json
{
  "mcpServers": {
    "ff_orbit_mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/absolute/path/to/ff-mcp",
      "env": {
        "FLUTTERFLOW_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

Or add it with CLI:

```bash
claude mcp add -s project -e FLUTTERFLOW_API_TOKEN=YOUR_TOKEN ff_orbit_mcp -- npm start
```

### Codex (CLI / App)

Option A: add via CLI:

```bash
codex mcp add ff_orbit_mcp --env FLUTTERFLOW_API_TOKEN=YOUR_TOKEN -- node /absolute/path/to/ff-mcp/dist/main.js
```

Build once before using the command above:

```bash
npm run build
```

Option B: add to `~/.codex/config.toml` (see `templates/codex-config.toml`):

```toml
[mcp_servers.ff_orbit_mcp]
command = "npm"
args = ["start"]
cwd = "/absolute/path/to/ff-mcp"
env = { FLUTTERFLOW_API_TOKEN = "YOUR_TOKEN" }
enabled = true
```

## Install the Orbit Skill (Recommended)

The skill teaches every Claude session about all 60+ Orbit commands automatically:

```bash
cp -r skills/flutterflow-orbit ~/.claude/skills/
```

After restart, Claude will know all Orbit commands, workflows, and your project setup in every session.

## Agent Rule Pack

This repository now includes a clone-ready rule/setup pack for agents:

- Rules: `.cursor/rules/`
- Playbook: `docs/agent-playbook.md`
- MCP config templates: `templates/mcp-config.local.json`, `templates/mcp-config-remote.json`, `templates/claude-code.mcp.json`, `templates/codex-config.toml`
- Installer script: `scripts/install-cursor-rules.sh`

Install rules into another repo:

```bash
./scripts/install-cursor-rules.sh /absolute/path/to/target-project
```

## Orbit Command Palette

Primary tool signature:

```ts
orbit({
  cmd: string,
  args?: object,
  snapshot?: string,
  format?: "json" | "explain"
})
```

Discover commands:

```ts
orbit({ cmd: "help" })
```

Core groups:

- Discovery: `projects.list`, `snapshots.create`, `snapshots.refresh`, `snapshots.refreshSlow`, `snapshots.ensureFresh`, `snapshots.info`, `snapshots.ls`
- API capabilities: `api.capabilities`
- Query: `search`, `page.create`, `page.scaffold`, `page.get`, `page.update`, `page.preflightDelete`, `page.remove` (recommended), `page.delete` (low-level), `page.clone`, `component.get`, `component.extractFromWidget`, `component.instance.insert`, `tree.locate`, `tree.subtree`, `tree.find` (alias), `tree.validate`, `tree.repair`, `graph.nav`, `graph.usage`, `pages.list`, `textfields.list`, `widget.get`, `widget.getMany`, `widgets.list`, `widgets.find`, `widgets.findText`, `widgets.updateMany`, `widgets.copyPaste`, `widget.create`, `widget.insert`, `widget.wrap`, `widget.unwrap`, `widget.duplicate`, `widget.deleteSubtree`, `widget.replaceType`, `widget.removeChildren`, `widget.move`, `widget.moveMany`, `widget.reorder`, `widget.action.list`, `widget.action.get`, `widget.bindAction`, `widget.bindData`, `widget.set`, `widget.delete`, `selection.get`, `selection.clear`, `intent.run`, `routes.list`, `routes.listByPage`, `routes.validate`, `routes.upsert`, `routes.delete`, `settings.get`
- Summaries: `summarize.page`, `summarize.component`, `summarize.project`
- Editing: `changeset.new`, `changeset.add`, `changeset.preview`, `changeset.validate`, `changeset.apply`, `changeset.applySafe`, `changeset.rollback`, `changeset.revert`, `changeset.drop`
- Schema: `schema.search`, `schema.read`, `schema.snippet`

### High-ROI recipes

- Generate best-practice pages with deterministic recipes (preview-first):
  - `orbit({ cmd:"page.scaffold", args:{ name:"login2", recipe:"auth.login", preview:true } })`
  - `orbit({ cmd:"page.scaffold", args:{ name:"preferences", recipe:"settings.basic", params:{ toggles:["Notifications","Dark mode"] }, apply:true } })`
  - `orbit({ cmd:"intent.run", args:{ text:"create a list page called products with search", preview:true } })`
- Duplicate a widget twice:
  - `orbit({ cmd:"widget.duplicate", args:{ nameOrId:"login", nodeId:"id-Text_a", count:2, apply:true } })`
- Insert a widget in one call:
  - `orbit({ cmd:"widget.insert", args:{ nameOrId:"login", type:"Divider", beforeNodeId:"id-Button_b", apply:true } })`
- Batch-update text widgets:
  - `orbit({ cmd:"widgets.updateMany", args:{ nameOrId:"login", filter:{ type:"Text" }, set:{ text:"James NC" }, apply:true } })`
- Find widgets with one canonical search command:
  - `orbit({ cmd:"widgets.find", args:{ nameOrId:"login", type:"TextField", textContains:"Password" } })`
- Batch get exact widgets:
  - `orbit({ cmd:"widget.getMany", args:{ nameOrId:"login", nodeIds:["id-Text_a","id-Button_b"] } })`
- Route a button to another page:
  - `orbit({ cmd:"routes.upsert", args:{ nameOrId:"login", nodeId:"id-Button_b", toPageNameOrId:"DailyDashboard", apply:true } })`
- Inspect and validate page routes:
  - `orbit({ cmd:"routes.listByPage", args:{ nameOrId:"login", direction:"both" } })`
  - `orbit({ cmd:"routes.validate", args:{ nameOrId:"login", strict:true } })`
- Batch move and unwrap widgets:
  - `orbit({ cmd:"widget.moveMany", args:{ nameOrId:"login", nodeIds:["id-Text_b","id-Text_c"], afterNodeId:"id-Button_b", apply:true } })`
  - `orbit({ cmd:"widget.unwrap", args:{ nameOrId:"login", nodeId:"id-Row_wrap", apply:true } })`
- List/get widget trigger actions:
  - `orbit({ cmd:"widget.action.list", args:{ nameOrId:"login", nodeId:"id-Button_b" } })`
  - `orbit({ cmd:"widget.action.get", args:{ nameOrId:"login", nodeId:"id-Button_b", trigger:"ON_TAP" } })`
- Ensure snapshot freshness before read/write:
  - `orbit({ cmd:"snapshots.ensureFresh", args:{ staleMinutes:30 } })`
- Use sticky selection in conversational follow-ups:
  - `orbit({ cmd:"selection.get" })`
  - `orbit({ cmd:"intent.run", args:{ text:"unwrap this", apply:true } })`
- Safe apply orchestration:
  - `orbit({ cmd:"changeset.applySafe", args:{ changesetId:"chg_x", confirm:true } })`
- Rollback latest applied changeset:
  - `orbit({ cmd:"changeset.rollback", args:{ latestApplied:true, confirm:true, apply:true } })`
- Safer page delete flow:
  - `orbit({ cmd:"page.preflightDelete", args:{ nameOrId:"login2" } })`
  - `orbit({ cmd:"page.remove", args:{ nameOrId:"login2", apply:true } })`
  - `page.remove` attempts hard delete first, and can fall back to archive mode if FlutterFlow rejects delete payloads.
- Validate/repair tree integrity:
  - `orbit({ cmd:"tree.validate", args:{ nameOrId:"login" } })`
  - `orbit({ cmd:"tree.repair", args:{ nameOrId:"login", fixOrphans:true, fixMissingNodes:true, apply:true } })`

Optional support tools:

- `orbit_policy_get`
- `orbit_policy_set` (disabled unless `ORBIT_ALLOW_POLICY_WRITE=1`)
- `orbit_export_changeset`

## Snapshot Workflow

1. `orbit({cmd:"projects.list"})`
2. `orbit({cmd:"snapshots.create", args:{projectId:"..."}})`
3. Query against `snapshot` id
4. Run `snapshots.refresh` before sensitive changes to avoid stale decisions (now throttled by default to reduce 429s)

Orbit snapshots are point-in-time and may be stale.
When FlutterFlow returns `versionInfo` (`partitionerVersion`, `projectSchemaFingerprint`), Orbit stores it and uses it for smarter incremental refresh decisions.
If FlutterFlow is rate-limiting refresh (`429`), prefer budgeted crawl mode:
- `orbit({ cmd:"snapshots.refreshSlow", args:{ passes:4, pauseMs:15000, maxFetch:25, concurrency:1, sleepMs:250 } })`
- `orbit({ cmd:"snapshots.refresh", args:{ mode:"full", fetchStrategy:"bulk" } })` for low-request full sync attempts
- `orbit({ cmd:"snapshots.refresh", args:{ mode:"full", fetchStrategy:"file", maxFetch:5, concurrency:1, sleepMs:1000 } })` for chunked full sync without relisting each pass (`chunkedFull` defaults to true for full+file)

## Safe Editing Workflow

1. `changeset.new`
2. `changeset.add` (one or many patches)
3. `changeset.preview` (diff + risk)
4. `changeset.validate` (YAML + structure + policy)
5. `changeset.apply` with `confirm:true` (includes remote `validateProjectYaml` checks before push)

If policy requires manual approval, apply is refused and a manual payload is returned.

## Policy Engine

Default file: `orbit.policy.json`

Fields:

- `allowProjects`
- `allowFileKeyPrefixes`
- `denyFileKeyPrefixes`
- `maxFilesPerApply`
- `maxLinesChanged`
- `requireManualApproval`
- `allowPlatformConfigEdits`
- `safeMode`: `readOnly | guidedWrite | fullWrite`

Env overrides:

- `ORBIT_POLICY_ALLOW_PROJECTS`
- `ORBIT_POLICY_ALLOW_FILE_PREFIXES`
- `ORBIT_POLICY_DENY_FILE_PREFIXES`
- `ORBIT_POLICY_MAX_FILES_PER_APPLY`
- `ORBIT_POLICY_MAX_LINES_CHANGED`
- `ORBIT_POLICY_REQUIRE_MANUAL_APPROVAL`
- `ORBIT_POLICY_ALLOW_PLATFORM_CONFIG_EDITS`
- `ORBIT_POLICY_SAFE_MODE`
- `ORBIT_ALLOW_POLICY_WRITE=1` (to enable `orbit_policy_set`)

## Running Tests

### Unit Tests

```bash
npm test
```

100/101 tests pass (1 pre-existing mock timing issue).

### Integration Tests

The integration test script tests against a live FlutterFlow project:

```bash
# Edit PROJECT_ID in run-tests.mjs if using a different project
node run-tests.mjs
```

This tests: help, api.capabilities, intent.run, schema.search, policy, API connection, snapshot creation, page listing, search, graph navigation, and project summary.

> **Note**: FlutterFlow's API has aggressive rate limiting. If you get 429 errors, wait 2-3 minutes and retry.

---

## Fly.io Deployment

```bash
flyctl launch
flyctl secrets set FLUTTERFLOW_API_TOKEN=your_token_here
flyctl deploy
```

`fly.toml` is configured with auto-suspend:

- `auto_start_machines = true`
- `auto_stop_machines = "suspend"`
- `min_machines_running = 0`

## Development

```bash
npm run build
npm test
npm start
```

## Troubleshooting

| Problem | Solution |
|---|---|
| `npm install` fails on `better-sqlite3` | Install C++ build tools (see step 1 above) |
| `Cannot find module './dist/main.js'` | Run `npm run build` first |
| `orbit` tool not showing in editor | Restart the editor after adding MCP config |
| `FLUTTERFLOW_API_TOKEN` missing error | Check your `.mcp.json` env vars — token must be set |
| FlutterFlow 429 rate limit errors | Wait 2-3 minutes, then retry. Set `FLUTTERFLOW_API_MIN_INTERVAL_MS=2000` for slower requests |
| `SQLITE_CANTOPEN` error | The `.orbit/` directory is auto-created. Check write permissions in your working directory |
| Port 8080 already in use | Set `ORBIT_HTTP_ENABLED=0` in env (recommended for MCP-only use) |
| Snapshot takes too long | First sync downloads all project files (can be 10k+). Subsequent syncs are incremental |

## Security Notes

- Keep `FLUTTERFLOW_API_TOKEN` only in environment variables or secret managers.
- Snapshot DB can include full project YAML and should be treated as sensitive data.
- `orbit.policy.json` should be code-reviewed because it controls write boundaries.
- **Beast mode**: Custom code guards are removed. If you need read-only guards, set `safeMode` to `guidedWrite` or `readOnly` in `orbit.policy.json`.

## FlutterFlow Project APIs Coverage

Orbit supports all currently documented FlutterFlow Project APIs (v2) through the adapter layer:

- `POST/GET /l/listProjects`
- `GET /listPartitionedFileNames`
- `GET /projectYamls` (including `projectYamlBytes` base64 zip decoding)
- `POST /validateProjectYaml`
- `POST /updateProjectByYaml`
