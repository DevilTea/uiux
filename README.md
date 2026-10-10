# UIUX

[Live UIUX Spec](https://deviltea.github.io/uiux/) · read-only static publication of this repository's canonical `design/` Workspace

`@deviltea/uiux` is the single-package home for the UIUX local-first UI/UX specification, preview, and review workbench.

The package provides a Nuxt SPA and a unified Nitro server. `uiux init --workspace <dir>` creates a minimal current-schema file-native Workspace, and `uiux dev --workspace <dir>` explicitly selects one Workspace and starts the Workbench/API/MCP process against it.

## Requirements

- Node.js 24.11 or later in the Node 24 line
- pnpm 10.34.4

## Development

```sh
pnpm install
pnpm dev
```

For product use, initialize a Workspace once and then start the unified server:

```sh
uiux init --workspace ./design
uiux dev --workspace ./design
```

## The Workbench

Sign in with the link `uiux dev` prints, then work from the sidebar (an icon rail on tablets, a bottom bar on phones):

- **Overview** answers "what needs me?": counts of threads waiting for review and open, and Views blocked from handoff. Its **Views** tab is the one list of every View, with Review, Checks, Evidence and Readiness columns and the View you opened last marked (`/views` lands here); **Checks** lists findings (schema validation, translation reminders, Preview runtime warnings); **Activity** lists recent Review activity (comments, replies, submissions, resolutions) and the version timeline: autosaves, named Checkpoints and changes made outside UIUX, each comparable with its parent or the current files. *Export handoff…* starts here.
- **A View** opens on the canvas: the live Preview at its canonical viewport size, with Variant, Locale, Viewport and Theme selectors for the render context (independent of the Workbench's own language and theme). The left panel holds the Widget tree; the right panel has **Comments**, **Inspect** (the selected Widget), **Spec** (intent, rules, constraints, accessibility, references, Decisions), **Readiness** (does it validate, is its Evidence fresh, are its Reviews closed, can it be handed off; capture Evidence and export from here) and **History** (the View's versions, compared side by side or highlighted on the canvas, and restored one resource at a time).
- **Comments** live on the canvas. Pick the Comment tool (`C`) and click a Widget to drop a pin and write; pins open their thread in place. A thread can be replied to, resolved (humans only, in the Workbench), reopened, re-anchored, promoted to a Decision, or submitted for review with change domains and fresh formal Evidence (*Submit for review…*). Feedback about the product as a whole is a **Workspace comment**: *New comment* in Reviews, or *Comment on Workspace* in `⌘K`; it never appears on a canvas. You can edit your own messages until a later submission or resolution (they show "· edited" with their Edit history), and delete your own brand-new comment until someone engages with it. The Resolve menu has two groups: **Resolve** (Answered, Verified) and **Dismiss** (No longer relevant, Duplicate, Won't do); dismissed threads leave the canvas.
- **Reviews** is the inbox for every thread: `ready-for-review` first, then `open`, newest activity first, resolved hidden unless asked for (*Resolved* is Verified and Answered; *Dismissed* is its own tab). Filter by View (or *Workspace*), anchor state, Variant scope, change domain and author, and search. Each thread shows one timeline of messages, re-anchors, submissions and lifecycle events, and deep-links to its exact View and render context. `J`/`K` move between threads, `R` replies, `E` resolves, `O` opens the thread on the canvas.
- **UX Flows** are graphs of steps (a View, optionally a Variant) joined by transitions (a Widget event). Edit them on desktop; *Play prototype* runs the Flow as a clickable prototype on any device.
- **Workspace**, one quieter entry at the foot of the sidebar, holds the secondary authoring pages, switched with the tabs at their top: **Settings** (General, Viewports, Themes and Adapters; `/workspace/adapters` opens that section), **Locales** and **Assets**; and **Members** (Owners, from the member menu at the top right) manages the roster, tokens and sessions.

`⌘K` / `Ctrl+K` searches and jumps anywhere, `?` lists every keyboard shortcut, and Workbench preferences switch the UI language (English, 繁體中文) and theme. Desktop gets everything. Tablets get review: canvas, comments, resolve and reopen, Flows and the player; structural editing stays on desktop. Phones get reading the Spec plus triaging and replying to comments.

## Server surfaces

Nitro serves `GET /api/health`, selected-Workspace point reads under `/api/resources/:kind/:key`, discovery endpoints under `/api/resources/list` and `/api/resources/search`, safe binary asset content delivery under `/api/assets/:id/content`, authoring endpoints under `/api/*`, and MCP at `/mcp`. The Workbench lists canonical resources, displays their content and diagnostics, and refreshes from the same selected-Workspace application facade used by HTTP and MCP.

MCP exposes compact read-only discovery plus domain-specific authoring operations with revision CAS:
- Views: `create_view`, `update_view_spec`, `update_view_structure`
- Workspace settings: `update_workspace_settings`
- Locales: `create_locale`, `update_locale`
- UX Flows: `create_flow`, `update_flow`
- Reviews: `create_review_thread`, `append_review_message`, `edit_review_message`, `reanchor_review_thread`, `set_review_display_hint`, `submit_ready_for_review`, `resolve_review_thread`, `reopen_review_thread`, `promote_review_to_decision`, `retract_review_thread`
- Authored Assets: `create_asset`, `replace_asset`
- Agent edit leases: `acquire_lock`, `release_lock`
- Version history: `list_versions`, `get_version_diff`, `create_checkpoint`, `restore_resource_version`, plus the read-only Resource `uiux://version/{id}`

These are domain-specific operations rather than generic Resource writes or JSON Patch surfaces.

When the Workspace is momentarily busy (another UIUX operation holds the persistence lock past its wait budget), `/api/*` answers `503` with `Retry-After` and the retryable code `persistence.busy`; on `/mcp` a tool returns the same code as an error result and a resource read as a JSON-RPC error. Nothing was read or written, so the same request can be retried. The Workbench retries reads once on its own. Handoff assessment, Handoff export and formal capture on a Workspace that still needs `uiux migrate` return `422` `blocked` with `workspace.migration_required`.

Resolving a Review thread is a human act performed in the Workbench (`POST /api/reviews/:id/resolve`). `resolve_review_thread` stays registered on `/mcp` but always refuses with guidance: agents reply on the thread or submit it ready for review. A resolution is `verified` (accepts the evidence-gated ready-for-review submission) or closes the thread without a verified change: `answered`, `wont-fix`, `duplicate` (requires a reason) or `obsolete`. The Workbench groups the last three as *Dismiss*; the resolution values are unchanged.

A Review anchor is either a Widget `{ viewId, widgetId }` (`widgetId: "root"` for a whole View) or the Workspace `{ scope: "workspace" }` (schemaVersion 3), for feedback about the product as a whole. Workspace threads take `variantNames: []` and no display hint, can be re-anchored to and from a Widget, cannot be promoted to a Decision (`review.decision_target_unavailable`), and submit against the current Workspace manifest revision plus every View they name. An open Workspace thread blocks `implementation-ready` for every Handoff root; `coverage.review.workspaceThreads` counts them. `list_resources` and `search_resources` (and `POST /api/resources/list|search`) accept `anchorScope: ["workspace" | "view"]`.

A Widget thread may record the render context it was raised in (schemaVersion 4): `create_review_thread` and `reanchor_review_thread` (`POST /api/reviews`, `POST /api/reviews/:id/reanchor`) take an optional `renderContext: { locale?, viewportId?, themeId? }` with at least one member. Each member must name a key the Workspace has at write time: a viewport or theme id authored in the Workspace settings (the built-in fallbacks `default` and `light` are not keys unless authored) and a Locale that has an i18n file or is the default Locale. An unknown key is refused with `review.render_context_unknown_key` and nothing is written; a Workspace thread refuses any `renderContext` (`review.render_context_without_widget`). On re-anchor an object sets the context, `null` clears it and omitting it keeps the recorded one; a re-anchor to the Workspace clears it, and the re-anchor event records the context on both sides. Review summaries from `list_resources` and `search_resources` include `renderContext`.

Authors, humans and agents alike, have two more operations on their own words, on both transports:
- `edit_review_message` / `PUT /api/reviews/:id/messages/:messageId` `{ expectedRevision, body }` replaces the text of your own message; the previous text is kept in the message's `edits[]`. It refuses `review.message_edit_not_author` (someone else's, or a message written before authors were identified), `review.message_edit_after_formal_act` (a later ready-for-review submission or resolution exists; reopening does not lift it), `review.message_body_empty` and `review.message_edit_noop`.
- `retract_review_thread` / `DELETE /api/reviews/:id` `{ expectedRevision }` permanently deletes your own brand-new thread: open, only your one message, no history, submissions or promoted Decision. It answers `200 { status: "deleted" }`, or refuses with `review.retract_not_author` or `review.retract_engaged` and a `reason` (`status`, `messages`, `history`, `submissions` or `promoted`); an engaged thread can only be dismissed. An empty thread with no messages can be retracted by any Reviewer.

### Members, roles and tokens

Every `/api/*` and `/mcp` request needs a credential. Each Workspace has its own roster of members on this host, at `$UIUX_HOME/workspaces/<sha256(realpath)>/access.json` (`UIUX_HOME` defaults to `~/.uiux`). The roster never lives in the Workspace or in Git, and it stores only hashes of secrets. A member has a nickname, a kind (`human` or `agent`, fixed at creation) and one cumulative role: Viewer ⊂ Reviewer ⊂ Editor ⊂ Owner. Agents are capped at Editor and can never resolve Review threads.

The first `uiux dev` of a Workspace creates its Owner, named after your OS user, and prints a single-use sign-in link (valid for 24 hours). Open it in the browser to sign in. The session lasts 14 days idle and 30 days at most, and it survives restarts. Lost the link? Run `uiux invite create --workspace <dir> --member <nick>` for a new one.

Manage the roster with the CLI (each command needs `--workspace <dir>` and works while the server runs), or as the Owner on the Workbench **Members** page:

```sh
uiux member add|list|set|remove ...
uiux token create|list|revoke ...      # tokens print once; 90 days by default, --expires never to opt out
uiux invite create --member <nick>     # a single-use browser sign-in link
uiux session list|revoke ...
uiux access copy --from <old-dir> --workspace <new-dir> [--replace]
```

A moved or renamed Workspace, and every git worktree, starts with an empty roster. `uiux access copy` carries members, tokens and the host version history over once, so existing agent tokens keep working and the timeline continues; it refuses to copy history into a Workspace that a running server holds. Copy before you run `uiux migrate` on the new path: the target's own history (such as the migration's Checkpoint boundary versions and its system version) is not merged, and `--replace` discards the target's roster and that history, printing how many versions it discarded.

Review actors and times on `/api/*` and `/mcp` are stamped by the server from the signed-in member (`member:<uuid>`). A supplied `actor` or `at` is ignored with the warnings `auth.actor_ignored` and `auth.time_ignored`. Resolving needs a human member on a Workbench session; bearer tokens get `review.resolve_requires_workbench`. Role refusals are `403 auth.scope_denied`, naming the required role.

### Connect an agent

`/mcp` always requires `Authorization: Bearer <token>`, loopback included. Give every concurrently running agent its own member:

```sh
uiux member add claude --workspace ./design --kind agent --role editor
uiux token create --workspace ./design --member claude
export UIUX_MCP_TOKEN=uiux_t_...   # in your shell profile or a gitignored .envrc, never in Git
```

Then point the MCP client at the server. For Claude Code, this project-scope `.mcp.json` carries no secret and is safe to commit, because Claude Code expands `${UIUX_MCP_TOKEN}` from the environment:

```json
{
  "mcpServers": {
    "uiux": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${UIUX_MCP_TOKEN}"
      }
    }
  }
}
```

The CLI equivalent is `claude mcp add --transport http uiux http://127.0.0.1:3000/mcp --header "Authorization: Bearer $UIUX_MCP_TOKEN"`. With `--scope project`, single-quote the header so `${UIUX_MCP_TOKEN}` stays literal. MCP clients read their config at startup, so restart the agent session after changing it.

Without a valid token `/mcp` answers `401` with `WWW-Authenticate: Bearer realm="uiux"` and a body that names the fix, and the Owner sees "MCP clients without a token" on the Members page. UIUX advertises no OAuth metadata (`/.well-known/*` is a JSON `404`). The per-request MCP instructions tell the agent its nickname and role.

An agent's first successful write to a View, Flow, Locale, Asset or the Workspace settings takes a 5-minute edit lease, renewed by each of its writes. Other writers get `423` with `resource.locked`, the holder's nickname and the expiry, and the Workbench shows "Locked by <nickname>". For a multi-step task, call `acquire_lock` up front for every resource it will write and finish with `release_lock`. Leases complement `expectedRevision`; they never replace it. Review threads are never locked, and an Owner can release a lock from the Workbench.

Consider denying `uiux member`, `token`, `invite`, `session` and `access` in your agent's permission settings: shell access as the host user is Owner-equivalent.

### Workspace schema migration

A Workspace records its format in `.uiux/workspace.json` `schemaVersion`. An older recognized Workspace opens read-only (`migration_required`) until it is migrated explicitly, from the command line only:

```sh
uiux migrate --workspace ./design --dry-run   # print the steps and changed files, write nothing
uiux migrate --workspace ./design             # apply atomically and print the new manifest revision
```

The current format is `schemaVersion` 4. Steps chain: `uiux.v1-to-v2` (resolution kinds, pin hints), `uiux.v2-to-v3` (Workspace-scoped threads and editable messages; it changes only the manifest), then `uiux.v3-to-v4` (the optional Review thread `renderContext`; it changes only the manifest), so a version 1 Workspace migrates in one run. `uiux init` writes version 4.

`uiux migrate` refuses while a running UIUX server holds the Workspace; stop `uiux dev` first. There is no MCP or HTTP migration entrypoint. Before its first step a real run writes the Checkpoint `Before migration to schemaVersion <N>` (`<N>` the target version) into the Workspace (a failed migration leaves it in place), and after it succeeds it records the migration as a system version in the host history under `$UIUX_HOME`. A dry run, and a Workspace that is already current, write nothing.

### Loopback-only access

The LAN listener is not yet available, so `uiux dev` listens on loopback only: `127.0.0.1` by default, with the port taken from the standard Nitro `PORT` / `NITRO_PORT` variables (default `3000`). It prints the address it actually listens on. Setting `HOST` or `NITRO_HOST` to a loopback address (`127.0.0.1`, `::1` or `localhost`) is allowed; any other value makes `uiux dev` refuse to start.

Every request, including `/mcp`, `/api/*` and Workbench assets, must address the server as `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; any other `Host` gets `421` (DNS-rebinding protection). State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`), and every `/mcp` request, are refused with `403` when a browser marks them as cross-origin (`Origin` not equal to the server's own origin, or `Sec-Fetch-Site` other than `same-origin` / `none`). State-changing requests that carry a body must send `Content-Type: application/json` (otherwise `415`). Non-browser clients such as curl, scripts and MCP CLIs that send no `Origin` keep working; they authenticate with `Authorization: Bearer <token>`. The server sends no CORS headers, and pages are served with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so only the Workbench itself can frame them (as it does for `/preview`).

## Static publication

`uiux publish` materializes a selected Workspace as a portable, read-only interactive site. The published viewer does not require Nitro, MCP, filesystem access, or an API server at runtime; canonical resources, Preview adapter runtime, Assets, Formal Evidence artifacts, and the Workspace Handoff readiness assessment are captured at build time.

```sh
pnpm build
uiux publish --workspace ./design --out ./.pages --base /uiux/ --source-revision "$(git rev-parse HEAD)"
```

`--base` makes the generated shell safe for project subpaths such as GitHub Pages. Publication output carries a deterministic content identity plus optional source-revision provenance. Authoring controls are removed in published mode; View context switching, Preview, Inspector, UX Flows, review history, evidence inspection, and readiness remain interactive.

This repository dogfoods that command in the `Publish UIUX Spec` GitHub Actions workflow and deploys the result to [GitHub Pages](https://deviltea.github.io/uiux/).

## Dogfood Workspace

This repository keeps its own UIUX specification in `design/`. Initialize a new Workspace with `uiux init`; once a UIUX server is running against it, agents should author canonical resources through domain-specific MCP tools rather than editing files in `design/` directly. The Workbench is the human inspection surface for the same canonical state.

## Checks

```sh
pnpm check
```

This runs the `.spec/` validation, ESLint, Nuxt typechecking, Vitest, the production build, and a live Nitro health-route smoke check.

It also packs the public npm artifact from source, installs that tarball into an isolated temporary project, initializes a Workspace through the installed `uiux init`, starts it through `uiux dev --workspace <dir>`, and exercises the live HTTP/MCP selected-Workspace path.

Vitest also drives the Workbench in Playwright Chromium for the browser suites (`tests/*-browser.test.ts`), and formal Evidence capture uses the same Playwright runtime.

### Performance budgets

```sh
pnpm perf
```

The geometry and comment-pin performance suites (`tests/geometry-perf.test.ts`, and the frame-budget test in `tests/comment-pins-browser.test.ts`) always measure and print their per-frame numbers (`[geometry-perf]`, `[pins perf]`). The absolute timing budgets of the multi-target geometry decision are defined for reference devices, not shared CI runners, so `pnpm check` gates only on checks that do not depend on machine speed: no frames and no messages while idle, pins on their Widgets' current geometry, reports per frame bounded and small. `pnpm perf` builds, then runs those suites with `UIUX_PERF_BUDGETS=1`, which also enforces the timing budgets; run it on a machine that stands in for a reference device. `PIN_PERF_THROTTLE=1,2,4` adds CPU throttling to the pin run and `PIN_PERF_REPORT=<dir>` writes its numbers as JSON.

## Domain contracts

The authority for UIUX behavior and external contracts is the repository specification in `.spec/`, maintained with `@deviltea/spec-tool`: Stories, Features with their Rules, Contracts with their Clauses (the persisted Workspace format, mutation semantics, MCP, the CLI, access control, the Adapter interface, the Handoff bundle, Workbench links and the Preview cross-iframe protocol) and Scenarios. `pnpm spec:validate` checks it, and `pnpm check` runs that too. GitHub Discussions #1–#10 keep the rationale and history of the decisions it records; see `AGENTS.md` for how new decisions reach `.spec/`.

In code, canonical Workspace resources and their validators live under `src/domain/`. The Widget executable IR remains Adapter/Widget-owned; UIUX validates only its reserved `RootShell` identity boundary. Application revision envelopes are separate from persisted resources, and Preview cross-iframe DTOs live under `src/preview/protocol/`. Workspace adapters are validated server-side by Node authority, and materialized on-demand into standalone browser bundles for the Preview iframe runtime mount without mixing Vue or widget module instances into the parent Nuxt Workbench.
