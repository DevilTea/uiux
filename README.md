# UIUX

`@deviltea/uiux` is the single-package home for the UIUX local-first UI/UX specification, preview, and review workbench.

The package provides a Nuxt SPA and a unified Nitro server. `uiux init` creates a minimal current-schema file-native Workspace, by default in `.uiux/` at the top of your Git repository, and `uiux dev` selects one Workspace and starts the Workbench/API/MCP process against it.

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
uiux init   # creates <git toplevel>/.uiux/ (./.uiux/ outside a repository), or --workspace <dir>
uiux dev    # from anywhere in the repository
```

`uiux init` writes `workspace.json`, an empty `product-kit.json`, an `access-presets.json` holding the built-in Access presets (Viewer, Reviewer, Editor and Owner), an empty default-Locale file `i18n/en-US.json` (`{}`, so a Preview renders right away) and a `.gitignore` for the runtime files, `kit/node_modules/` and `kit/dist/`. The Workspace's Adapters live in `product-kit.json`; a `./` Adapter is a module in the Workspace's `kit/` directory. It refuses a directory that is `$UIUX_HOME` (default `~/.uiux`), lies inside it or contains it, since that directory holds host-local rosters and history.

Every command that acts on a Workspace (`dev`, `components` and the access commands) takes an optional `--workspace <dir>`: the Workspace root, or a directory whose `.uiux/` holds one. Without it, the command uses the `.uiux/` of the nearest directory, from the current one upward to your home directory, that has a `.uiux/workspace.json`; outside your home directory it looks only in the current directory. When that is a Workspace from before `schemaVersion` 5, whose `.uiux/` held only its metadata, its parent directory is the Workspace. The search refuses a `.uiux/` that is a symbolic link, that another user owns or others can write, or that sits in a directory others can write (such as `/tmp`) and you do not own; pass `--workspace` to select such a Workspace explicitly. Where the platform has no user id (Windows), only these bounds and the symbolic link check apply.

## The Workbench

Sign in with the link `uiux dev` prints, then work from the sidebar (an icon rail on tablets, a bottom bar on phones):

- **Overview** answers "what needs me?": counts of threads waiting for review and open, and Views blocked from handoff. Its **Views** tab is the one list of every View, with Review, Checks, Evidence and Readiness columns and the View you opened last marked (`/`, the default tab); **Checks** lists findings (schema validation, translation reminders, Preview runtime warnings); **Activity** lists recent Review activity (comments, replies, submissions, resolutions) and the version timeline: autosaves, named Checkpoints and changes made outside UIUX, each comparable with its parent or the current files. *Export handoff…* starts here.
- **A View** opens on the canvas: the live Preview at its canonical viewport size, with Variant, Locale, Viewport and Theme selectors for the render context (independent of the Workbench's own language and theme). The left panel holds the Widget tree; the right panel has **Comments**, **Inspect** (the selected Widget), **Spec** (intent, rules, constraints, accessibility, references, Decisions), **Readiness** (does it validate, is its Evidence fresh (a capture follows the View's IR and Variants, so a Spec or name edit keeps it fresh), are its Reviews closed, can it be handed off; capture Evidence and export from here) and **History** (the View's versions, compared side by side or highlighted on the canvas, and restored one resource at a time).
- **Comments** live on the canvas. Pick the Comment tool (`C`) and click a Widget to drop a pin and write; pins open their thread in place. A thread can be replied to, resolved (humans only, in the Workbench), reopened, re-anchored, promoted to a Decision, or submitted for review with change domains (`ir`, `variant`, `spec`, `metadata`, `flow`, `asset`, `i18n`, `settings`, `adapter`, `product-kit`; the dialog says whether they require new captures) and fresh formal Evidence (*Submit for review…*). Feedback about the product as a whole is a **Workspace comment**: *New comment* in Reviews, or *Comment on Workspace* in `⌘K`; it never appears on a canvas. You can edit your own messages until a later submission or resolution (they show "· edited" with their Edit history), and delete your own brand-new comment until someone engages with it. The Resolve menu has two groups: **Resolve** (Answered, Verified) and **Dismiss** (No longer relevant, Duplicate, Won't do); dismissed threads leave the canvas.
- **Reviews** is the inbox for every thread: `ready-for-review` first, then `open`, newest activity first, resolved hidden unless asked for (*Resolved* is Verified and Answered; *Dismissed* is its own tab). Filter by View (or *Workspace*), anchor state, Variant scope, change domain and author, and search. Each thread shows one timeline of messages, re-anchors, submissions and lifecycle events, and deep-links to its exact View and render context. `J`/`K` move between threads, `R` replies, `E` resolves, `O` opens the thread on the canvas.
- **UX Flows** are graphs of steps (a View, optionally a Variant) joined by transitions (a Widget event). Edit them on desktop; *Play prototype* runs the Flow as a clickable prototype on any device.
- **Workspace**, one quieter entry at the foot of the sidebar, holds the secondary authoring pages, switched with the tabs at their top: **Settings** (General, Viewports, Themes), **Product Kit** (its packages, kit build and Adapters, then Components with its read-only Catalog of the active Adapters' Widget types, Styles & themes and Files), **Access presets**, **Locales** and **Assets**; and **Members** (Owners, from the member menu at the top right) manages the roster, tokens and sessions.

`⌘K` / `Ctrl+K` searches and jumps anywhere, `?` lists every keyboard shortcut, and Workbench preferences switch the UI language (English, 繁體中文) and theme. Desktop gets everything. Tablets get review: canvas, comments, resolve and reopen, Flows and the player; structural editing stays on desktop. Phones get reading the Spec plus triaging and replying to comments. Renaming a View and editing its feature tag, from the View page header, work on every device.

## Server surfaces

Nitro serves `GET /api/health`, selected-Workspace point reads under `/api/resources/:kind/:key`, discovery endpoints under `/api/resources/list` and `/api/resources/search`, safe binary asset content delivery under `/api/assets/:id/content`, authoring endpoints under `/api/*`, the change-event stream `GET /api/events` (server-sent events), and MCP at `/mcp`. The Workbench lists canonical resources, displays their content and diagnostics, and reads them through the same selected-Workspace application facade used by HTTP and MCP. Every committed write, from HTTP or MCP, emits a content-free `resource.changed` / `resource.removed` event (`lock.changed` for edit leases, `access.changed` for the roster), so an open Workbench re-reads what changed without a reload; edits made to Workspace files outside UIUX are not detected.

MCP exposes compact read-only discovery plus domain-specific authoring operations with revision CAS:
- Views: `create_view`, `update_view_spec`, `update_view_structure`, `update_view_metadata`, `delete_view`
- Workspace settings: `update_workspace_settings`
- Requirement references: the `requirements` of `create_view`, `update_view_spec` (in `spec`), `update_view_structure` (on each Variant entry), `create_flow` and `update_flow`, and the `requirements` setting of `update_workspace_settings`; the read-only Resource `uiux://requirements`
- Locales: `create_locale`, `update_locale`
- UX Flows: `create_flow`, `update_flow`, `delete_flow`
- Reviews: `create_review_thread`, `append_review_message`, `edit_review_message`, `reanchor_review_thread`, `set_review_display_hint`, `submit_ready_for_review`, `resolve_review_thread`, `reopen_review_thread`, `promote_review_to_decision`, `create_decision_from_review`, `retract_review_thread`
- Decisions: `defer_decision`, `decide_decision` (needs the human-only key `decisions.decide`, so a Workbench session), `reopen_decision`
- Authored Assets: `create_asset`, `replace_asset`, `delete_asset`
- Agent edit leases: `acquire_lock`, `release_lock`
- Version history: `list_versions`, `get_version_diff`, `create_checkpoint`, `restore_resource_version`, plus the read-only Resource `uiux://version/{id}`

These are domain-specific operations rather than generic Resource writes or JSON Patch surfaces.

Deleting a View, UX Flow or Asset, removing a Variant name with `update_view_structure`, and removing or renaming a viewport or theme key with `update_workspace_settings` change what other resources refer to. Each analyzes the reference impact first (Review threads, UX Flow steps, View Spec references, `$asset` bindings and render contexts) and, when it is not empty, writes nothing and answers `impact_acknowledgement_required` (HTTP 409) with `impacts`; call again with `acknowledgeImpact: true` to write. Nothing that refers to the changed resource is rewritten: its references keep their target and are reported as dangling diagnostics. The same applies on HTTP (`DELETE /api/views|flows|assets/:id` with `{ expectedRevision, acknowledgeImpact? }`), where the Workbench lists the impact and asks for confirmation.

When the Workspace is momentarily busy (another UIUX operation holds the persistence lock past its wait budget), `/api/*` answers `503` with `Retry-After` and the retryable code `persistence.busy`; on `/mcp` a tool returns the same code as an error result and a resource read as a JSON-RPC error. Nothing was read or written, so the same request can be retried. The Workbench retries reads once on its own. Handoff assessment, Handoff export and formal capture on a Workspace at another `schemaVersion` return `422` `blocked` with `workspace.schema_unsupported`.

Resolving a Review thread is a human act performed in the Workbench (`POST /api/reviews/:id/resolve`). `resolve_review_thread` stays registered on `/mcp` but always refuses with guidance: agents reply on the thread or submit it ready for review. A resolution is `verified` (accepts the evidence-gated ready-for-review submission) or closes the thread without a verified change: `answered`, `wont-fix`, `duplicate` (requires a reason) or `obsolete`. The Workbench groups the last three as *Dismiss*; the resolution values are unchanged.

A Review anchor is either a Widget `{ viewId, widgetId }` (`widgetId: "root"` for a whole View) or the Workspace `{ scope: "workspace" }` (schemaVersion 3), for feedback about the product as a whole. Workspace threads take `variantNames: []` and no display hint, can be re-anchored to and from a Widget, cannot be promoted to a Decision (`review.decision_target_unavailable`), and submit against the current Workspace manifest revision plus every View they name. An open Workspace thread blocks `implementation-ready` for every Handoff root; `coverage.review.workspaceThreads` counts them.

`list_resources` and `search_resources` (and `POST /api/resources/list|search`) take Review filters, each a non-empty array matching any listed value; different filters combine with AND, and any of them returns Review threads only: `resolution`, `anchorScope` (`workspace` | `view`), `status` (`ready-for-review` | `open` | `resolved` | `dismissed`, where `resolved` means `verified` or `answered` and `dismissed` the other resolutions), `viewId` (View IDs, or `workspace`), `variant` (Variant names, or `*` for View-wide threads), `anchor` (`valid` | `stale` | `missing`) and `changeDomain` (any submission). A Review summary carries `latestMessage: { id, actor, at, excerpt, edited }` (the first 200 grapheme clusters of the last message) and, while the thread is ready for review or resolved and not reopened since, `currentSubmission: { id, at, changeDomains }`.

Both also take an optional `detail`: `summary` (the default) keeps the items exactly as compact as above, and `expanded` adds a bounded `detail` member to each item, with the same `limit` and `cursor` paging. A View adds `variantNames`, `intentExcerpt` (200 grapheme clusters of `spec.intent`), `specCounts` and `decisionCounts`; a UX Flow `entryStepId`, `stepCount`, `transitionCount` and the target `viewIds`; a Locale `isDefault`; a Review thread `submissionCount`, `historyCount`, `participants` (its distinct actors, with `removed: true` on a member no longer on the roster, as in other Review reads), `firstMessageExcerpt` (200 grapheme clusters) and, with a `currentSubmission`, its `evidenceRefs`; an Asset `byteSize` and `digest`. IR, full message text, Locale messages and Asset content stay behind each item's Resource. Any other `detail` is refused (`discovery.invalid_detail`).

A Widget thread may record the render context it was raised in (schemaVersion 4): `create_review_thread` and `reanchor_review_thread` (`POST /api/reviews`, `POST /api/reviews/:id/reanchor`) take an optional `renderContext: { locale?, viewportId?, themeId? }` with at least one member. Each member must name a key the Workspace has at write time: a viewport or theme id authored in the Workspace settings (the built-in fallbacks `default` and `light` are not keys unless authored) and a Locale that has an i18n file or is the default Locale. An unknown key is refused with `review.render_context_unknown_key` and nothing is written; a Workspace thread refuses any `renderContext` (`review.render_context_without_widget`). On re-anchor an object sets the context, `null` clears it and omitting it keeps the recorded one; a re-anchor to the Workspace clears it, and the re-anchor event records the context on both sides. Review summaries from `list_resources` and `search_resources` include `renderContext`.

Authors, humans and agents alike, have two more operations on their own words, on both transports:
- `edit_review_message` / `PUT /api/reviews/:id/messages/:messageId` `{ expectedRevision, body }` replaces the text of your own message; the previous text is kept in the message's `edits[]`. It refuses `review.message_edit_not_author` (someone else's, or a message written before authors were identified), `review.message_frozen`, naming the submission or resolution that froze it (a later ready-for-review submission or resolution exists; reopening does not lift it), `review.message_body_empty` and `review.message_edit_noop`.
- `retract_review_thread` / `DELETE /api/reviews/:id` `{ expectedRevision }` permanently deletes your own brand-new thread: open, only your one message, no history, submissions or promoted Decision. It answers `200 { status: "deleted" }`, or refuses with `review.retract_not_author` or `review.retract_engaged` and a `reason` (`status`, `messages`, `history`, `submissions` or `promoted`); an engaged thread can only be dismissed. An empty thread with no messages can be retracted by any Reviewer.

### Members, roles and tokens

Every `/api/*` and `/mcp` request needs a credential. Each Workspace has its own roster of members on this host, at `$UIUX_HOME/workspaces/<sha256(realpath)>/access.json` (`UIUX_HOME` defaults to `~/.uiux`). The roster never lives in the Workspace or in Git, and it stores only hashes of secrets. A member has a nickname, a kind (`human` or `agent`, fixed at creation) and a set of permission keys, such as `views.write` or `members.manage`. The roster stores each member's keys, and a member's label names the built-in preset (Viewer, Reviewer, Editor or Owner) whose keys match, or Custom. Keys for people only, such as `reviews.resolve` and `members.manage`, are never stored on an Agent, and at least one human member always keeps `members.manage`. `uiux member add` takes `--preset <name>` (Viewer, Reviewer, Editor or Owner), which copies that preset's keys, `--keys <k,…>` or `--all-keys`; `uiux member set` takes `--preset`, `--grant <k,…>` and `--revoke <k,…>`. An Agent given a preset or `--all-keys` gets the keys without the ones for people only. A key this version does not know is refused.

Deciding a Decision needs the human-only key `decisions.decide`, which only the Owner preset has. Members store their keys in the roster, so an existing Owner does not gain it from this version, and `--preset owner` in an older Workspace uses that Workspace's old Owner preset: grant it with `uiux member set <nick> --grant decisions.decide --workspace <dir>`.

The first `uiux dev` of a Workspace with no human holder of `members.manage` creates one with every key, named after your OS user, and prints a single-use sign-in link (valid for 24 hours). Open it in the browser to sign in. The session lasts 14 days idle and 30 days at most, and it survives restarts. Lost the link? Run `uiux invite create --workspace <dir> --member <nick>` for a new one.

Manage the roster with the CLI (each command selects the Workspace like `uiux dev` and works while the server runs), or as the Owner on the Workbench **Members** page (on a loopback URL or an `https` origin, see Network access):

```sh
uiux member add <nick> --preset Editor  # or --keys workspace.read,reviews.write, or --all-keys
uiux member set <nick> --grant members.manage   # --preset, --grant, --revoke, --nickname
uiux member list [--keys]              # ACCESS: the preset label or Custom; KEYS: the key count
uiux member remove <nick>
uiux token create|list|revoke ...      # tokens print once; 90 days by default, --expires never to opt out
uiux invite create --member <nick>     # a single-use browser sign-in link
uiux session list|revoke ...
uiux access copy --from <old-dir> --workspace <new-dir> [--replace]
```

UIUX reads one roster format, `version: 2`, whose members hold keys ([Discussion #231](https://github.com/DevilTea/uiux/discussions/231)). A roster at any other version, or one whose Token or session record carries a field from before Discussion #174 (`lan`, `listener`), is refused with `access.store_invalid` and is never rewritten.

A moved or renamed Workspace, and every git worktree, starts with an empty roster. `uiux access copy` carries members, tokens and the host version history over once, so existing agent tokens keep working and the timeline continues; it refuses to copy history into a Workspace that a running server holds. Histories are never merged: the target must have no roster, and `--replace` discards the target's roster and its own history, printing how many versions it discarded.

Review actors and times on `/api/*` and `/mcp` are stamped by the server from the signed-in member (`member:<uuid>`). A supplied `actor` or `at` is ignored with the warnings `auth.actor_ignored` and `auth.time_ignored`. Resolving needs a human member on a Workbench session; bearer tokens get `review.resolve_requires_workbench`. Each operation needs permission keys; a refusal is `403 auth.scope_denied` whose `requiredKeys` names the keys the request lacks.

#### Recovering a roster

When UIUX refuses a roster (`access.store_invalid`), the message names the file, `$UIUX_HOME/workspaces/<sha256 of the Workspace root's real path>/access.json`, and what is wrong with it. Stop every `uiux dev` for that Workspace before you touch the file, and keep it mode 0600.

- **A hand-edited roster.** Fix what the message names. Each member's `keys` must be an array of distinct permission key names. An Agent must not hold `reviews.resolve`, `checkpoints.delete`, `locks.force-release`, `presets.manage` or `members.manage`, so remove them or the member. When no human member holds `members.manage` after your fix, the next `uiux dev` creates one and prints its sign-in link.
- **A roster at another version** (a `version` other than 2): one above 2 was written by a newer UIUX, so use that UIUX. An older roster is not upgraded: move its directory aside and start again; the next `uiux dev` creates a roster and prints a manager's sign-in link.
- **A Token with `lan` or a session with `listener`.** These fields come from before Discussion #174. Delete the named field from the record, or revoke the session by removing its record.

### Connect an agent

`/mcp` always requires `Authorization: Bearer <token>`, loopback included. Give every concurrently running agent its own member:

```sh
uiux member add claude --workspace ./.uiux --kind agent --preset Editor
uiux token create --workspace ./.uiux --member claude
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

### Workspace format

A Workspace records its format in `workspace.json` `schemaVersion`. This UIUX reads only `schemaVersion` 7, which `uiux init` writes. There is no migration: no command, MCP tool or HTTP route upgrades a Workspace. `uiux dev`, the packaged server and every roster command refuse a Workspace at any other `schemaVersion` before touching it (exit status 2, `workspace.schema_unsupported`, naming the version found), and a Workspace whose manifest changes to another version under a running server cannot be changed. To start over, run `uiux init` in a new directory ([Discussion #231](https://github.com/DevilTea/uiux/discussions/231)).

### Requirement references

A View's Spec, each of its Variants and each UX Flow can list requirement references: opaque IDs of requirements that the product's own specification states (for this repository, the UUIDs of `.spec/` Rules). Each ID is 1 to 200 characters with no leading or trailing white space, unique in its array, and an array holds at most 100. Every authoring tool that takes `requirements` keeps the existing references when the member is omitted and clears them for `[]`; a Variant entry of a new name starts with none. A reference-only edit changes no render-input digest and no Flow input digest, so it stales no Evidence.

The optional `requirements` setting of `workspace.json` names where the requirements come from:

```json
{ "requirements": { "provider": "spec", "path": "../.spec", "noUi": { "<rule-uuid>": "Why this requirement has no UI." } } }
```

- `{ "provider": "spec", "path": "<relative path>" }` reads the Rules of a Spec Tool workspace (`@deviltea/spec-tool`, read-only) at `path` relative to the Workspace root. `path` names the directory that holds `.spec/`, or `.spec/` itself, and its real path must lie inside the Git work tree that holds the Workspace root. An ID the provider lacks is kept as written and reported as `requirements.unresolved`; a provider that cannot be read is `requirements.provider_unavailable`.
- `{ "provider": "url", "template": "https://example.com/req/{id}" }` turns each reference into a link in the Workbench and supplies no coverage.
- `noUi` maps requirement IDs to reasons: a requirement marked `noUi` is outside coverage, whatever references it.

Reading a Spec Tool workspace takes its read lock, which creates and removes the coordination files `.spec-tool-v1.lock` and `.spec-tool-v1.readers/` beside `.spec/`. Add both to the `.gitignore` of the repository that holds the `.spec/` a `spec` provider reads (this repository already does).

The Resource `uiux://requirements` (and, for the Workbench, `GET /api/requirements`) holds `{ provider, status, counts, requirements, unresolved, unverified }`. `status` is `none`, `url`, `ok` (a `spec` provider that was read) or `unavailable`; only `ok` lists each requirement as `referenced`, `unreferenced` or `noUi` with the Views, Variants and Flows that reference it, and `unverified` lists every referenced ID that is not checked against a provider read with `ok`, so an unreadable provider never looks like full coverage. With a `spec` provider the Workbench's Overview has a Requirements tab with the same coverage.

### Writing an Adapter

An Adapter types its manifest with the public authoring entry `@deviltea/uiux/adapter`, the only module of the package besides `package.json` that its `exports` map exposes. It exports the types `AdapterManifest`, `AdapterCatalog`, `AdapterWidgetCatalogEntry`, `AdapterAssetCapability`, `AdapterAssetValue`, `I18nFieldMapping`, `TranslationResult`, `TranslationWarning`, `RootShellInterfaces`, `AdapterProviderContext`, `JsonValue` and `AdapterApiVersion`, and three string constants: `TRANSLATION_RESULT_VALUE_CONTRACT_ID` and `STRING_VALUE_CONTRACT_ID`, the value contracts of an i18n `resultProperty` and `textProperty`, and `WIDGET_ID_ATTRIBUTE`, the attribute a renderer puts on each Widget's outermost element. Its runtime module imports nothing, and its types import only from `@deviltea/widget-core`, `@deviltea/widget-vue` and `vue`, which an Adapter declares as peer dependencies: the Preview gives every Adapter the host's single `@deviltea/widget-core`, so an Adapter never bundles its own. UIUX supplies the entry from its own package wherever it loads an Adapter (the server, the Preview bundle and the Adapter's content digest), so a kit, even one with its own `kit/package.json`, needs no `@deviltea/uiux` installed to run one; installing it as a development dependency gives the kit's own TypeScript checks the types. The entry follows the Adapter API version: a new minor of API version 1 only adds to it, and a breaking type change needs a new major. It exports no value naming the API version a host implements; an Adapter writes the lowest minor it relies on as its `apiVersion`. The dogfood reference Adapter, `.uiux/kit/adapters/reference.ts`, uses it.

```ts
import { createWidgetValueContract } from '@deviltea/widget-core'
import { STRING_VALUE_CONTRACT_ID, type AdapterManifest } from '@deviltea/uiux/adapter'

const STRING = createWidgetValueContract<string>(STRING_VALUE_CONTRACT_ID)
export const manifest: AdapterManifest = { id: 'my-ds', apiVersion: '1', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [] }
```

Each `providers` entry is a Vue plugin: an object with an `install` function, or a function. When the Preview mounts, after the Product Kit stylesheet has loaded and before the first render, UIUX installs every Adapter's providers on the Preview's Vue app, in Adapter-list order and then entry order. The `app.use` options are a frozen `AdapterProviderContext`, `{ adapterId, config }`. `config` is a deep-frozen copy of the Adapter entry's `config` as it passed the Adapter's `configSchema`, or `undefined` when the entry has none. The install context is the only way Adapter code receives its configuration, so a renderer that needs it reads what its own provider passed to `app.provide`. A provider installs synchronously; one that throws, or returns a promise, makes the Preview invalid with a diagnostic naming the Adapter and the entry. A provider runs only in the Preview, never on the server, and undoes any global side effect it makes outside the app through `app.onUnmount`. The configuration is embedded in the Preview bundle, so it is not secret. Changing it builds a new bundle, and Handoff records its digest as the Adapter's `configDigest`.

```ts
import type { App, InjectionKey } from 'vue'
import type { AdapterProviderContext } from '@deviltea/uiux/adapter'

export const MY_DS_CONFIG: InjectionKey<AdapterProviderContext['config']> = Symbol('my-ds-config')
const configProvider = { install: (app: App, context: AdapterProviderContext) => void app.provide(MY_DS_CONFIG, context.config) }
// A renderer reads it with `inject(MY_DS_CONFIG)`.
```

A translatable field is declared in the Catalog as `catalog.widgets.<Type>.i18n.fields.<field> = { configField, resultProperty?, textProperty?, params? }`. `configField` names the top-level string Config member that receives the key of an authored `{ "$i18n": "<key>" }`, and is always required. `resultProperty` (a `TranslationResult` Property) and `textProperty` (a string Property) may be omitted: an omitted `textProperty` is `<field>` and an omitted `resultProperty` is `<field>Result`. A declared name wins, and a derived name is checked like a declared one: the Widget plugin must declare it with the right value contract, and it must not collide with another name in the same Widget's mapping (`{ configField: 'title' }` for the field `title` collides with its derived `textProperty`). The reference Adapter's `i18nField` helper writes `{ configField: '<field>Key' }` and names its Properties `<field>Result` and `<field>`.

Only a top-level Config member takes an `$i18n` binding; a binding inside an array or object member is not lowered. A translatable collection, such as a list of tabs or segments, is therefore one child Widget per item, each with its own translatable field, instead of an array of labels in the parent's Config: the reference Adapter's `TabBar` and `SegmentedControl` hold `TabBarItem` and `Segment` children, each declaring `i18nFields('label')`.

A field that takes an Asset is declared as `catalog.widgets.<Type>.assetFields.<field> = { acceptedMediaTypes?, acceptedCategories? }`, with at least one non-empty list. A category is the top-level type of an Asset's media type, so `image` accepts `image/png` and `image/svg+xml`. A View binds an Asset there with `{ "$asset": "<assetId>" }` in a top-level Config member, and the Widget's Config receives, under the same field name, a frozen `AdapterAssetValue` `{ url, mediaType, contentDigest }` in its place, so the Widget's Config schema accepts that object. `url` is an opaque same-origin URL to render the content from, for example as an `<img>` `src`; do not parse or build it. A binding in a field that is not asset-capable, to an Asset that does not exist or is invalid, or to an Asset whose media type the field does not accept keeps the View from rendering and from being captured, and the View's diagnostics name it; writing the View is still accepted. When a bound Asset is replaced, an open Preview resolves it again.

An Adapter selects the implementation sources that Handoff records with the optional `sources` member, keyed by Widget types it owns: `sources.<Type> = { semantic, renderer, designSystem?, supporting? }`, where `supporting` is a list and each source is a file `{ path, package?, embed? }` or a provenance-only `{ url }` (an `http` or `https` URL). A file's `path` is relative and stays inside its root: the root of `package` as Node module resolution finds it from the Adapter's root, otherwise the package root of a package Adapter, or `kit/` for a `./` Adapter. At export, each readable file is snapshotted by content identity and its reference records the package, the revision (the package version, or the content digest when there is none) and the path, with `selection: "adapter-mapping"`. A file with `embed: false`, and a `url`, is `provenance-only`; a missing, unreadable, out-of-root or non-regular file (a link leaving its root, a directory, a FIFO) and a file over 2 MiB (`reason: "too-large"`) are `unavailable`; neither blocks `implementation-ready`. A used Widget type without an entry keeps the Adapter's entry module as both its semantic and its renderer source, marked `selection: "entry-module-fallback"`. `sources` is read only on the server, and a malformed entry or a Widget type the Adapter does not own makes the Adapter invalid (`adapter.invalid_sources`). Each formal capture record's `provenance.versions` names the `playwright` and `chromium` versions that produced it.

### Cleaning up derived artifacts

Captures, Checkpoints and Handoff exports store their blobs in the Workspace's content-addressed `artifacts/`, and no normal action deletes one. `uiux artifacts gc` is the only cleanup:

```sh
uiux artifacts gc --workspace ./.uiux --dry-run   # list what would be deleted; delete nothing
uiux artifacts gc --workspace ./.uiux             # delete it
```

It keeps the Evidence that a Review submission references, the blobs that a Checkpoint references, the blobs that this host's history of the Workspace (under `$UIUX_HOME`, including the open autosave) references, and the latest Evidence record of each View and render context, with everything those blobs reference: a kept blob keeps every `sha256:` identity it contains. "Latest" follows the version timeline of the View revision an Evidence record names (Checkpoints, host versions, the open autosave, Review submissions and the View's current revision), never file times; when that order cannot be decided, every record of that View and render context is kept. Handoff blobs are not kept: an exported bundle has its own copies. It prints each deleted blob's `sha256:` identity, then their count and total bytes. It refuses a Workspace that a running `uiux dev` serves (stop the server first), and, deleting nothing, one whose Review thread, Checkpoint, host history or stored blob it cannot read.

The cleanup sees only this checkout and this host's history. When `artifacts/` is committed, as in a shared Workspace, the deletions reach every other clone with the commit that records them, including blobs that another host's history still names. A host copies the blobs its versions need into its own history when it records a version or starts, so only versions recorded before that copy are at risk; review the `--dry-run` list before you commit the result.

### Capturing formal Evidence from the command line

`uiux evidence capture` captures formal Evidence through a running `uiux dev` server, the way an Agent does through the `capture_formal_evidence` tool or the Workbench does through `POST /api/evidence/capture`: the server stays the one writer, and the same capture service runs. It signs in as the member whose Token you give it, which needs `evidence.capture` (the Editor preset has it). The Token is read from `--token-file <path>` (a file only you can read; `-` reads standard input, which must not be a terminal) or, without it, from the `UIUX_TOKEN` environment variable, such as one that your CI sets from its secret store. `--token-file` is the recommended source. There is no option that takes the Token itself, so it never appears in argv or a process list, the command never prints it, and its error messages never repeat an argument that might be one. Do not type the Token into your shell (`export UIUX_TOKEN=...` would put it in the shell history).

```sh
# the Token of a member made with `uiux token create --member <nick>`, saved in a file only you can read
uiux evidence capture --all --token-file ~/.config/uiux/token --workspace ./.uiux      # every View x Locale x viewport x theme, base context
uiux evidence capture --view <id> --viewport mobile --theme dark --token-file ~/.config/uiux/token --workspace ./.uiux
uiux evidence capture --view <id> --variant empty --json --token-file ~/.config/uiux/token --workspace ./.uiux
```

`--all` captures every View in every Locale, viewport preset and theme at its base context, the contexts that `pnpm dogfood:check` requires fresh Evidence for; it never includes a Variant and cannot be combined with the other selection options. `--view <id>` (repeatable) captures the named Views, in the Workspace's default Locale, viewport and theme unless `--locale`, `--viewport` or `--theme` (each repeatable) name others; `--variant <name>` (repeatable) adds that Variant next to each base context. The command resolves the selection into an explicit list of render contexts from the selected Workspace on disk and sends it in requests of at most eight; naming a View, Locale, viewport, theme or Variant the Workspace lacks is refused before anything is sent. The server is `--origin <url>`, else the loopback origin that the `uiux dev` server running on this host for the Workspace records in its hold; with neither, the command exits 1.

The run stops at the first request that the server refuses (a response without per-context results, such as 401 or 403, or no answer) or answers with 422 (no context of that request was captured: a server-wide precondition such as a kit build that is not ready, or a request that failed whole); a 207 (some contexts captured) does not stop it. The contexts not sent are reported as not attempted. It prints one tab-separated line per context answered (`captured` or `failed`, View id, Variant or `-`, Locale, viewport id, theme id, evidence digest) and `Captured <n> of <selected> contexts, <m> failed[, <k> not attempted].`; failures and refusals go to standard error. `--json` prints one object instead, `{ status: "ok" | "incomplete" | "failed", results: [{ context, status, evidenceDigest?, screenshotDigest?, diagnostics? }], summary: { selected, captured, failed, notAttempted } }`. Exit status: 0 when every context was captured, 1 when the server refuses (a Token it does not accept, a member without `evidence.capture`, a kit build that is not ready), none is found or answers, or any context fails (`incomplete` included), and 2 for invalid usage, no Token, or an unusable Workspace root. A Token sent to an `http` origin other than loopback travels in clear text, and the command warns once on standard error; it never follows a redirect.

### Copying components into a product project

`uiux components` copies registry components of the Product Kit out of the Workspace's `kit/src/` into a product project. It reads the Workspace directly and needs no credential:

```sh
uiux components list --workspace ./design                          # the registry components
uiux components add button --to src/ui --workspace ./design         # copy button and what it requires into src/ui/
uiux components diff --check --workspace ./design                   # report drift; exit 1 on any
```

`add` copies each named component and its `requires` closure into the `--to` directory, keeping each file's path below `kit/src/` (`kit/src/ds/Button.vue` becomes `src/ui/ds/Button.vue`), and prints the packages, with the version ranges `kit/package.json` declares, that the copies need. The product project is `--project <dir>`, else the nearest directory with a `package.json` at or above `--to` (the current directory for `diff`), else the Git top level. Its `uiux-components.json` records every copy: the target, a digest per file and per component, and paths relative to the project and to `kit/` only. Without `--force`, `add` refuses a copy that was changed since it was copied, a file in the way that is not a recorded copy, and a component already copied to another directory (naming it); with `--force` it overwrites and moves the component, but still refuses a move that would leave a recorded component requiring a moved one behind, naming it (name that component too to move both). `--to` lies strictly inside the product project, outside the Workspace and outside `.git`, and so must every path the copy record names, or the command refuses before writing anything. It never writes through a symbolic link in the product project nor reads one in `kit/src/`. `diff` reports each recorded file as `unchanged`, `modified`, `upstream`, `diverged`, `missing` or `removed`.

### Network access

By default `uiux dev` listens on loopback only: `127.0.0.1`, with the port taken from the standard Nitro `PORT` / `NITRO_PORT` variables (default `3000`). It accepts only the loopback host names, and it prints its loopback URL at startup. `--host` picks the bind address. It takes a loopback address (`127.0.0.1`, `::1` or `localhost`), or a wildcard address (`0.0.0.0` or `::`) that listens on every interface. A loopback `HOST` or `NITRO_HOST` still works when `--host` is absent; any other value makes `uiux dev` refuse to start.

Other machines reach the server only through origins you configure with `--origin`, which may repeat:

```sh
# Behind a reverse proxy on the same host: keep the loopback bind and list the public origin.
uiux dev --workspace ./.uiux --origin https://uiux.corp.example

# Directly on a LAN: listen on every interface and list the origin people type.
uiux dev --workspace ./.uiux --host 0.0.0.0 --origin http://10.0.0.5:3000
```

An origin is `http://` or `https://`, a host and an optional `:<port>`, with no path: UIUX is served on a dedicated hostname, never under a path prefix. `uiux dev` refuses to start in these cases:
- a wildcard bind without any `--origin`;
- an invalid origin;
- two origins that share a host and port;
- two origins on one host that both use their scheme's default port, such as `http://uiux.corp` and `https://uiux.corp`;
- an origin that is one of the loopback addresses it already serves.

At startup the server prints its loopback URL and each configured origin. On the first run it also prints the Owner's sign-in link on each of them. The links share one single-use invite, so use only one.

Every request, including `/mcp`, `/api/*` and Workbench assets, must name the server in its `Host` header. It can name a loopback host on the bound port (`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`), or the host and port of a configured origin. A `Host` without a port matches the configured origin on that host that uses its scheme's default port. Any other `Host` gets `421`, which protects against DNS rebinding. A loopback `Host` is accepted only from a connection that comes from this machine. Two more checks protect against cross-site requests. State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) and every `/mcp` request are refused with `403` when they carry an `Origin` other than the origin their `Host` matched, or a `Sec-Fetch-Site` other than `same-origin` / `none`. State-changing requests that carry a body must send `Content-Type: application/json` (otherwise `415`). Non-browser clients such as curl, scripts and MCP CLIs send no `Origin` and keep working on every accepted origin; they authenticate with `Authorization: Bearer <token>`. The server sends no CORS headers, and it serves pages with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so only the Workbench itself can frame them (as it does for `/preview`).

On a configured origin, members sign in and work as they do on loopback, with the same credentials and roles, with these differences:
- **Sessions.** A browser session belongs to the origin it signed in on, so each origin needs its own sign-in.
- **Cookies and links.** The session cookie carries `Secure` on an `https` origin. Sign-in links the Workbench creates name the origin it is open on.
- **One host, two schemes.** The cookie name is the same on every origin (`uiux_session_<hint>`), and a browser keeps one cookie per name and host whatever the scheme or port. After someone signs in on `https://uiux.corp.example`, the browser holds a `Secure` cookie for that host and ignores the cookie that a sign-in on `http://uiux.corp.example:8080` sets, so that origin keeps returning to the sign-in page. Give an `http` origin its own host name, or use only the `https` origin for people who use both.
- **Roster administration.** Managing members, Tokens, invites and sessions works only on a loopback URL or an `https` origin. Elsewhere it is refused with `403 access.admin_origin_rejected`. The `uiux member|token|invite|session` commands on the host always work.
- **Formal capture.** It still loads Preview from the internal loopback origin.

`uiux invite create` without `--origin` names the loopback origin on the running server's port. Pass `--origin https://uiux.corp.example` for a link that people on the network can open.

**Plain HTTP on a network.** UIUX itself serves plain HTTP only. It refuses `NITRO_SSL_CERT` / `NITRO_SSL_KEY`, and it never reads `X-Forwarded-Proto` or other forwarding headers. An `https` origin is served by a front end that terminates TLS. On an `http` origin other than loopback, sign-in links, session cookies and Tokens cross the network in clear text, and anyone on that network can capture and reuse them. UIUX warns about each such origin at startup and on its sign-in page. Prefer an `https` origin behind a TLS-terminating reverse proxy; use a plain `http` LAN origin only on a network you trust.

**Reverse proxy.** The proxy must forward the client's `Host` unchanged, with its port, and must not buffer the response streams (`/mcp` answers and `/api/events` are server-sent events). For nginx:

```nginx
server {
    listen 443 ssl;
    server_name uiux.corp.example;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;   # the client's Host, port included
        proxy_set_header Connection "";
        proxy_buffering off;                 # stream server-sent events as they are written
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

With a proxy on the same host, keep the default loopback bind: the proxy is then the only way in. A wildcard bind (`--host 0.0.0.0` or `::`) also serves the plain port to the network, so with only `https` origins `uiux dev` prints a warning at startup; keep the loopback bind, or block the raw port with a firewall.

A proxy that rewrites `Host` to the loopback address makes its requests look local. State-changing requests then fail the `Origin` check, but reads and roster administration would be treated as local, so always forward `Host`. Failed sign-in attempts are rate-limited per connecting address. Every client behind one proxy therefore shares a single limit of 10 failures a minute.

## Dogfood Workspace

This repository keeps its own UIUX specification in `<repo>/.uiux/`, a `schemaVersion` 7 Workspace (rebuilt fresh at the current schema, issue #382). Initialize a new Workspace with `uiux init`; once a UIUX server is running against it, agents should author canonical resources through domain-specific MCP tools rather than editing files in `.uiux/` directly. The Workbench is the human inspection surface for the same canonical state.

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
