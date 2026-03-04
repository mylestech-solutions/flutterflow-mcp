---
name: flutterflow-orbit
description: FlutterFlow Orbit MCP server (Beast Mode) — 60+ commands for full FlutterFlow project control via the `orbit` tool. Use when working with FlutterFlow projects, editing pages/widgets/components, managing snapshots, creating changesets, or querying project structure. Covers all CRUD operations, scaffold recipes, navigation graphs, and transactional write workflows.
metadata:
  author: mylestech-solutions
  version: "1.0"
---

# FlutterFlow Orbit (Beast Mode)

## Overview

Orbit is an MCP server that provides a single `orbit` tool with 60+ commands for full FlutterFlow project control. All reads come from a local SQLite snapshot cache; writes go through a transactional changeset flow with rollback support.

## Connection

The Orbit MCP server must be configured in `.mcp.json`. The tool name is `orbit` with a `cmd` parameter.

```
orbit({ cmd: "help" })
```

## Key Project

- **MedzenHealth Pro**: `medzen-health-pro-0lbqv7`

## Essential Workflow

```
1. orbit({ cmd: "snapshots.create", args: { projectId: "medzen-health-pro-0lbqv7" } })
2. orbit({ cmd: "pages.list", args: { projectId: "medzen-health-pro-0lbqv7" } })
3. orbit({ cmd: "widgets.find", args: { page: "PageName", type: "Button" } })
4. orbit({ cmd: "changeset.new" })
5. orbit({ cmd: "changeset.add", args: { ... } })
6. orbit({ cmd: "changeset.preview" })
7. orbit({ cmd: "changeset.validate" })
8. orbit({ cmd: "changeset.apply", args: { confirm: true } })
```

## All Commands by Category

### Snapshot Management
- `snapshots.create` — first-time sync (downloads all files)
- `snapshots.refresh` — incremental refresh
- `snapshots.refreshSlow` — budgeted crawl (avoids 429s)
- `snapshots.ensureFresh` — refresh only if stale
- `snapshots.info` — snapshot metadata
- `snapshots.ls` — list all snapshots

### Project & Pages
- `projects.list` — list all FF projects
- `pages.list` — list pages in project
- `page.get` — full page YAML
- `page.create` — create new page
- `page.update` — update page YAML
- `page.scaffold` — generate from recipe (auth.login, auth.signup, settings.basic, list.cards.search, detail.basic)
- `page.clone` — duplicate a page
- `page.preflightDelete` — safety check before delete
- `page.remove` — delete page (safe, recommended)
- `page.delete` — delete page (low-level)

### Widget CRUD
- `widget.get` / `widget.getMany` — get widget(s)
- `widgets.list` — list widgets on page
- `widgets.find` — find by type/text/props
- `widgets.findText` — find text-containing widgets
- `textfields.list` — list all TextFields
- `widget.create` — create widget
- `widget.insert` — insert at position
- `widget.set` — set properties
- `widget.bindData` — bind data source
- `widget.bindAction` — bind action trigger
- `widget.duplicate` — duplicate N times
- `widget.wrap` / `widget.unwrap` — wrap/unwrap in container
- `widget.move` / `widget.moveMany` — move widget(s)
- `widget.reorder` — reorder children
- `widget.delete` / `widget.deleteSubtree` — delete widget/subtree
- `widget.replaceType` — change widget type
- `widget.removeChildren` — remove all children
- `widgets.updateMany` — batch update props
- `widgets.copyPaste` — copy between pages

### Widget Tree
- `tree.locate` — find widget in tree
- `tree.subtree` — get subtree from node
- `tree.find` — alias for search
- `tree.validate` — check integrity
- `tree.repair` — fix orphans/missing nodes

### Routes & Actions
- `routes.list` — all routes in project
- `routes.listByPage` — routes for specific page
- `routes.validate` — check route integrity
- `routes.upsert` — create/update route
- `routes.delete` — delete route
- `widget.action.list` — list triggers on widget
- `widget.action.get` — get specific trigger

### Changesets (Transactional Writes)
- `changeset.new` — start new changeset
- `changeset.add` — add patches
- `changeset.preview` — preview diff + risk
- `changeset.validate` — validate YAML + policy
- `changeset.apply` — push to FlutterFlow (needs `confirm: true`)
- `changeset.applySafe` — orchestrated apply with retry
- `changeset.rollback` — undo last applied
- `changeset.revert` — revert specific changeset
- `changeset.drop` — discard unapplied changeset

### Components
- `component.get` — get component details
- `component.extractFromWidget` — extract into component
- `component.instance.insert` — insert component instance

### Search & Graph
- `search` — full-text across symbols
- `graph.nav` — navigation graph (page links)
- `graph.usage` — component usage graph
- `summarize.page` / `summarize.component` / `summarize.project` — AI summaries

### Schema Docs
- `schema.search` — search widget/property docs
- `schema.read` — read full schema doc
- `schema.snippet` — get code snippet

### Utility
- `help` — list commands (pass `args: { cmd: "command.name" }` for details)
- `api.capabilities` — check adapter status
- `intent.run` — natural language to command
- `selection.get` / `selection.clear` — sticky selection
- `settings.get` — project settings

## Beast Mode

This server has custom code editing unlocked:
- `lib/custom_code/`, `lib/custom_functions/`, `lib/main.dart` are editable
- Policy: fullWrite, 500 files/apply, 50k lines, platform config edits enabled
- Risk score for custom code: +5 (awareness only, not blocking)

## MANDATORY Rules (Rate Limit Prevention)

1. **Always start sessions with ensureFresh, NOT refresh or create**:
   `orbit({ cmd: "snapshots.ensureFresh", args: { staleMinutes: 30 } })`

2. **NEVER use `apply: true` on individual edits** — batch into one changeset:
   `changeset.new` → `changeset.add` (all edits) → `changeset.preview` → `changeset.validate` → `changeset.apply`

3. **Use broad search, not one-by-one lookups**:
   - `widgets.find` / `widgets.findText` / `search` for bulk discovery
   - `summarize.page` for overview before deep-diving
   - Do NOT call `tree.locate` or `widget.get` repeatedly for the same page

4. **Know which commands hit the API vs local SQLite**:
   - API calls: `snapshots.create/refresh/refreshSlow/ensureFresh(if stale)`, `changeset.apply/applySafe`, `projects.list`
   - Local (free): `pages.list`, `widgets.*`, `search`, `graph.*`, `summarize.*`, `schema.*`, `tree.*`, `changeset.new/add/preview/validate`, `help`, `intent.run`

5. **For known YAML changes** — use `mcp__flutterflow__update_project_yaml` directly to bypass overhead

## Safety Rules

- Always use `changeset.preview` before `changeset.apply`
- Always pass `confirm: true` to apply/rollback
- Use `page.preflightDelete` before `page.remove`
- If getting 429 errors, wait 2-3 minutes or use `snapshots.refreshSlow`

## High-ROI Recipes

```
# Scaffold a login page
orbit({ cmd: "page.scaffold", args: { name: "login2", recipe: "auth.login", preview: true } })

# Find all buttons on a page
orbit({ cmd: "widgets.find", args: { nameOrId: "LoginPage", type: "Button" } })

# Batch update text
orbit({ cmd: "widgets.updateMany", args: { nameOrId: "LoginPage", filter: { type: "Text" }, set: { text: "Updated" }, apply: true } })

# Route a button to another page
orbit({ cmd: "routes.upsert", args: { nameOrId: "LoginPage", nodeId: "id-Button_b", toPageNameOrId: "Dashboard", apply: true } })

# Natural language command
orbit({ cmd: "intent.run", args: { text: "create a settings page with dark mode toggle" } })
```
