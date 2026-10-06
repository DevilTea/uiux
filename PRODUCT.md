# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **A small product team reviewing what AI agents author.** Designers and PMs read Views, comment on the canvas, and judge readiness. Developers author the Workspace with AI agents (for example Claude Code) through MCP, then implement production code from Handoff. Several named humans review in parallel. Each person is a member of the Workspace's host-local roster (under `$UIUX_HOME`, default `~/.uiux`) with one role, Owner, Editor, Reviewer or Viewer, and signs in to the Workbench with a one-time link; Review actions record the member (`member:<id>`) as actor provenance.
- **AI agents (non-human authors).** They are agent members of the roster and authenticate with a bearer token (`Authorization: Bearer <token>`). They write the canonical `design/` Workspace only through domain-specific MCP operations (`create_view`, `update_view_spec`, `update_view_structure`, `update_workspace_settings`, `create_locale`, `update_locale`, `create_flow`, `update_flow`, review lifecycle tools, asset authoring, and so on) under per-resource `expectedRevision` concurrency. They never use the Workbench UI, but every change they make must become legible there. Agents can create threads (on a Widget or on the Workspace as a whole), reply, edit their own messages (`edit_review_message`, until a later submission or resolution), withdraw their own unanswered threads (`retract_review_thread`), and submit threads to `ready-for-review` with an evidence bundle. They cannot resolve.
- **Readers of the published spec.** Anyone given the static `uiux publish` site (for example GitHub Pages) can browse Views, Preview, Inspector, Spec, UX Flows, review history, evidence and readiness. Authoring and review controls are removed there.
- **Downstream implementers (developers on the team or their agents).** They consume the Handoff export, which is a manifest-first, read-only reference contract.

## Product Purpose

UIUX (`@deviltea/uiux`) is a local-first UI/UX specification, preview and review workbench for human–agent collaboration. A file-native Workspace holds executable mockups. Views are made of Widget IR, rendered by the real Design System through Workspace adapters. Alongside them live named Variants, a structured View Spec (intent, entry conditions, interaction rules, constraints, accessibility, references, decisions), UX Flows, Review threads, Locales and authored Assets.

The Workbench is a **review desk**. Its core loop:

1. See what the agent changed.
2. Comment on the exact Widget, on the canvas.
3. Resolve, reopen, promote to a Decision, or move work toward `implementation-ready`.

Authoring panels (Workspace settings, Locales, Assets, Flow editing) are secondary. Evidence and Handoff are not destinations of their own. They show up as each View's readiness: does it validate, is its evidence fresh, are its Reviews closed, can it be handed off.

Success means:

- a reviewer can tell at a glance what changed, what is broken, and what is waiting for their judgment;
- a comment lands on the exact Widget in the exact render context, takes one gesture to create, and stays traceable after the tree changes;
- a View reaches `implementation-ready` backed by immutable evidence, not by assertion;
- an implementer can build from Handoff without asking the author what was meant.

## Positioning

Mockups in UIUX are **executable specifications, not drawings**. They render the shared production Design System inside an isolated iframe and live as plain files in the product's repository. Agents author them through a typed, revision-checked MCP surface. Humans own judgment:

- comments anchor to stable semantic `{ viewId, widgetId }` identity, not to pixels (or to `{ scope: "workspace" }` for feedback about the product as a whole);
- the Review lifecycle runs `open` → `ready-for-review` → `resolved`, and only a human may resolve;
- Decisions are promoted explicitly;
- Playwright captures are stored as content-addressed evidence;
- the output is a Handoff that traces each Widget back to its Design System source.

Figma comments sit on pixels of a drawing. Here, a Figma-like comment sits on a semantic Widget of a running View, under a declared render context, in the same canonical files that the agent and the human both read.

## Operating Context

- **Local, single process.** `uiux init --workspace <dir>` creates a Workspace at the current schema (`schemaVersion` 3) and `uiux dev --workspace <dir>` starts one Nitro process on loopback only (`127.0.0.1`). It serves the Workbench SPA (`ssr: false`), `/api/*`, `/mcp` and the Preview host for one selected Workspace. There is no cloud and no network dependency. The Workspace may or may not be in Git.
- **Access.** Every `/api/*` and `/mcp` request needs a credential: a Workbench session (from a one-time sign-in link) or a bearer token. Each Workspace has a host-local roster of members, tokens, invites and sessions under `$UIUX_HOME`, managed with `uiux member|token|invite|session ... --workspace <dir>` (`uiux access copy` carries a roster to a moved Workspace) or, for Owners, on the Workbench Members page. The first start of a Workspace creates its Owner and prints a sign-in link. Roles are cumulative: Viewer ⊂ Reviewer ⊂ Editor ⊂ Owner; agents are capped at Editor.
- **Older Workspaces.** `uiux migrate --workspace <dir> [--dry-run]` upgrades an older Workspace to `schemaVersion` 3 (steps `uiux.v1-to-v2`, then `uiux.v2-to-v3`). Migration is CLI-only; until it runs, the Workbench opens the Workspace read-only and names the command.
- **Side by side with an agent session.** A developer usually has an agent authoring through MCP in another window. Reviewers return to the Workbench to inspect the result. Refresh is manual today, and live push of agent edits is not built.
- **Team sharing happens through one host's roster, the Workspace files** (typically Git) **and the published static site.** Several members can use the same server, each signed in with their own credential, but the server listens on loopback only, so other devices cannot reach it yet. See Undecided.
- **Published, read-only mode.** `uiux publish --workspace <dir> --out <dir> [--base <path>] [--source-revision <rev>]` produces a static interactive site with authoring and review mutations removed. This repository dogfoods it at https://deviltea.github.io/uiux/.
- **Devices.**
  - **Desktop** (FHD 1920×1080 is primary) gets everything: authoring, review, evidence, Handoff.
  - **Tablet** (1024×768) gets review: canvas, comments, resolve and reopen, UX Flows and the Prototype player. Structural editing stays on desktop.
  - **Mobile** (390×844) gets reading the Spec plus triaging and replying to comments. There is no structural editing, and new canvas comments are not started on a phone.
- **Two independent sets of context.**
  - The Workbench chrome has its own UI language and its own light/dark theme. The UI language follows the browser and can be switched manually between en-US and zh-TW.
  - The previewed View has its own render context: Variant, plus the Workspace-defined locale, viewport and theme keys.
  - The two never drive each other. Switching the Workbench to zh-TW or dark leaves the Preview locale and theme unchanged, and the reverse is also true.
- **Rituals:**
  - an agent submits a thread to `ready-for-review` with a structured evidence bundle;
  - a human inspects the evidence, then resolves (accepting a specific submission) or reopens with feedback;
  - a human promotes a Review into a Decision (`pending` / `decided` / `deferred`);
  - Checks run, formal evidence is captured, readiness is assessed, and Handoff is exported.

## Capabilities and Constraints

**Built today (from `app/`):**

- primary navigation of **Overview / UX Flows / Reviews**, with Workspace pages as a secondary entry, and a `⌘K` command palette;
- an Overview with an attention line, the list of every View with its Reviews, Checks, Evidence and readiness, a Checks tab of findings only (no Review queues), an Activity tab, and Handoff export;
- a View page: the Preview iframe at the canonical logical viewport size, Variant / Locale / Viewport / Theme selectors, a Widget tree, and Comments / Inspect / Spec / Readiness panels (formal Evidence capture and Handoff readiness live in Readiness);
- comment pins, composers and thread bubbles drawn by the Workbench in an overlay above the iframe from iframe-reported geometry, with a click-to-comment mode exited with Escape, inline notices for missing or stale anchors, and a toast when a navigation target View is gone;
- a Reviews inbox: `ready-for-review` before `open`, resolved and dismissed threads in their own tabs, filters by View (or Workspace), anchor state, Variant scope, change domain and author, one chronological timeline per thread, and reply, resolve or dismiss, reopen, re-anchor, promote to Decision, submit for review, edit own message and delete own new thread;
- a node/edge UX Flow graph editor and a Prototype player;
- Workspace pages for Settings (including Adapters), Locales and Assets, and a Members page for Owners;
- a Preview session indicator, Workbench chrome i18n (en-US / zh-TW) and light/dark themes on Nuxt UI semantic color tokens;
- read-only publication mode.

**Accepted in architecture, not yet built:**

- the Component Catalog as a secondary area.

**Binding constraints:**

- Workspace files own the specification. The Workbench never holds duplicate canonical state, never silently repairs or auto-rebinds, and shows invalid, stale and missing states as repairable.
- The Preview iframe owns rendering, hit testing and geometry. The Workbench owns all review chrome. Canonical captures exclude review UI.
- Review anchors persist only `{ viewId, widgetId }` plus `variantNames`, or `{ scope: "workspace" }` for feedback about the product as a whole (schemaVersion 3, no Variants, no pin). A comment's click point is transient display data; the persisted pin hint is non-authoritative.
- A message's author may edit it until a later submission or resolution; every earlier version is kept on the message. An author may delete their own brand-new thread until someone engages; after that it can only be dismissed.
- Only a human, signed in to the Workbench, may resolve. Resolving as `verified` must reference the thread's current `ready-for-review` submission. An `open` thread can be resolved directly only without a verified change: Answered, or dismissed as Won't do, Duplicate (with a reason) or No longer relevant.
- Mutations go through the shared domain services: the same semantics as MCP and HTTP, with `expectedRevision` conflicts surfaced to the user.
- Stack: Nuxt 4 SPA, Nuxt UI 4, Tailwind CSS 4, a Nitro server, Lucide icons through Iconify, `@nuxtjs/i18n` for chrome strings, Node 24, pnpm. One public package. Nuxt UI components are used wherever one exists. No new Workspace schemas or external contracts without an accepted architecture decision.

**Terminology** (canonical): Workspace, View, Variant, Widget, RootShell (`root`), View IR, View Spec, Decision (`pending` / `decided` / `deferred`), Review thread (`open` / `ready-for-review` / `resolved`), anchor, re-anchor, UX Flow, step, transition, Prototype, render context (Variant × locale × viewport × theme), Checks, formal Evidence, capture, artifact, Assets, Adapter, Catalog, Handoff, `implementation-ready`.

**zh-TW terminology policy:** domain nouns stay in English inside Chinese UI: View, Variant, Widget, Review, Flow (UX Flow), Spec, Decision, Evidence, Handoff, Workspace, Locale, Asset and MCP, plus RootShell, Adapter and IR, and the role names Owner, Editor, Reviewer and Viewer. By the owner's decision of 2026-10-06, Token, Agent, Slot, Runtime, Manifest, Bundle (as in "Bundle ID") and Schema also stay in English, while Checks is 「檢查」 and Catalog is 「型錄」. Actions and general UI are translated, for example 「新增留言」 and 「標記為已解決」. The shared allowlist in `tests/support/i18n-allowlist.mjs` and the glossary tests enforce this. This keeps what an agent says, what MCP tools are named, and what the human sees aligned.

**Undecided:**

- **Reaching the server from other devices.** Several named members can already review on one host (roster, roles, sessions and tokens), but tablet or mobile review needs a device to reach the server, and `uiux dev` listens on loopback only. Until LAN or hosted exposure is decided, reviewers either run `uiux dev` locally against a shared (Git) Workspace or read the published site.
- Live updates when agents write. Part 1 allows future ephemeral change notifications, but none is specified.
- "What changed" beyond "updated since you last looked": showing a real diff needs revision history, which the Workspace model does not provide.

## Brand Commitments

- Product name **UIUX**, package `@deviltea/uiux`, CLI `uiux`. The Workbench is titled "UIUX Workbench".
- The favicon (near-black `#171717` rounded square with two violet `#a78bfa` bars) is the only identity asset. Its violet is the committed source of the Workbench accent. There is no logo or wordmark.
- **Voice: a precise instrument** (Figma / Linear register). Calm, terse and exact, with verbs before nouns. Protocol internals stay hidden unless something is wrong. IDs, revisions and evidence are one click away and never in the default view. No engineering-literal headings ("Real Iframe Boundary", "Atomic CAS promotion"), and no emoji as icons.
- Reference: Figma (canvas plus in-canvas comment threads). Rejected: the default Nuxt UI admin-template look, neon "hacker" dev-tool styling, AI-product gloss (gradients, glassmorphism, sparkles), and emoji used as icons.

## Evidence on Hand

- Dogfood Workspace `design/`: 4 Views ("UIUX Workbench — Workspace browser", "Overview & readiness", "Reviews inbox", "Sign-in"), 2 UX Flows, 6 Review threads, 1 Asset, locales `en-US` and `zh-TW`, themes `dark` and `light`, viewport presets `desktop` (1920×1080), `tablet` (1024×768) and `mobile` (390×844), reference adapter `design/adapters/reference.ts`.
- Screenshots of an earlier Workbench: `docs/pr-48/01-workbench-overview.png` to `05-handoff-export.png`.
- Live published spec: https://deviltea.github.io/uiux/
- Canonical architecture record: GitHub Discussions #1–#10. Implementation workstreams: Issues #11–#29.
- **Absent, so future work must not fabricate:** users, customers, testimonials, usage metrics, pricing or licensing claims, a logo or wordmark, and revision history or diffs.

## Product Principles

1. **The View is the subject.** The canvas and the thing under review get the stage. Chrome, metadata and protocol state support it and never compete with it.
2. **Agents author, humans judge.** The Workbench is tuned for reviewing agent output quickly. It makes the human-only acts deliberate, attributable and fast: comment, resolve, reopen, decide, declare ready.
3. **Show canonical truth honestly.** Never duplicate, guess, silently repair or auto-rebind. Invalid, stale, missing and conflicted states are visible, explained and repairable in place.
4. **Context is always explicit.** Every preview, comment, capture and deep link carries its full render context. Opening a link reproduces exactly what the author saw.
5. **Evidence over assertion, one click away.** Readiness and resolution rest on immutable captures and structured checks. Provenance is always inspectable but never in the way.

## Accessibility & Inclusion

- WCAG 2.2 AA for the Workbench chrome in both light and dark themes. This covers text and non-text contrast, visible focus that is not obscured, and 24×24 px minimum targets (44 px on touch layouts).
- Every canvas action has a non-pointer path. Comment targeting has a keyboard and tree-based alternative, and Escape exits targeting. Touch never depends on hover.
- Bilingual UI (en-US / zh-TW). Traditional Chinese must stay legible at the smallest chrome size, which means a 12 px floor with CJK-appropriate line height. Layouts tolerate the length differences between English and Chinese labels.
- Views carry an authored `spec.accessibility` list. Surfacing it is a product capability, separate from the Workbench's own accessibility.
