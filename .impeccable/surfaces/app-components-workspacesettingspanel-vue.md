---
version: 1
slug: "app-components-workspacesettingspanel-vue"
primary_target: "app/components/WorkspaceSettingsPanel.vue"
related_targets: ["app/components/LocalesPanel.vue","app/components/AssetsPanel.vue","app/pages/flows/[flowId].vue"]
---

# Shape brief (g): Secondary authoring surfaces (Workspace settings, Locales, Assets, UX Flows)

Mode: **Operate**. Visual authority: `DESIGN.md`. Targets: `WorkspaceSettingsPanel.vue`, `LocalesPanel.vue`, `AssetsPanel.vue` and `FlowsPanel.vue`, which are promoted from 320px rail panels to full pages under `/workspace/*` and `/flows/*`.

## 1. Job and audience

Agents do most authoring through MCP. Humans come here occasionally to:

- fix a translation;
- add a viewport preset;
- replace an icon asset;
- check how Views connect in a Flow and play it as a Prototype.

These visits are infrequent but precise. The surfaces must be calm, give each form a full page instead of a 320px rail, and make concurrency conflicts impossible to miss.

## 2. Outcome and proof

- Workspace settings, Locales, Assets and Adapters live under a secondary "Workspace" group at the sidebar foot (brief a). They are not primary navigation (Part 1 IA: settings are secondary; Catalog is secondary).
- Every mutation uses the domain operation that already exists, with `expectedRevision`:
  - `update_workspace_settings`;
  - `create_locale` / `update_locale`;
  - asset create, update-metadata and replace-content;
  - `create_flow` / `update_flow`.
- Conflicts surface as an explicit choice, never a silent overwrite.
- **UX Flows** (primary IA) offers a node/edge graph view, a structured editor for the selected step or transition, and the deterministic Prototype player. All three are projections of the one canonical Flow (Part 6 10c).
- The 12px floor, light and dark themes, and no emoji apply throughout.

## 3. Selected direction

Settings-page conventions in the Linear manner: a left section index, then one form column (maximum 720px) with sections separated by hairlines, and Save per section. Locales is a spreadsheet-like table, Assets a list or grid, and Flows a canvas-like graph on the same quiet ground as the View canvas. The Prototype player reuses the View canvas frame.

## 4. Scope and boundaries

- **In scope:**
  - **Settings:** General, Viewports, Themes, Adapters (selection, order, config; read-only package state with repair guidance).
  - **Locales:** key × locale table, primary locale, reminders.
  - **Assets:** library, upload, replace, metadata, usage, validation.
  - **Flows:** list, graph, step and transition editor, validation, and the Prototype player.
- **Untouched:**
  - Workspace, Flow, asset and locale schemas;
  - adapter dependency management, because the Workbench never runs package managers (Part 8 10a);
  - the Flow canonical shape (keyed steps with nested transitions, no transition UUID).
- **Anti-goals:**
  - modal form soup;
  - inline edit in 320px rails;
  - auto-repair of invalid references (Part 6 #7);
  - garbage-collecting unused assets (Part 9 #6).

## 5. Layout sketches

### Workspace settings (desktop)

```
┌ sidebar ┬ Workspace settings ───────────────────────────────────────────────────────────┐
│ …       │ General        │ Viewports                                             [Add]  │
│ ─────── │ Viewports  •   │ ─────────────────────────────────────────────────────────── │
│ ✻ Work… │ Themes         │ Key (mono)      Label          Width × Height               │
│  Setti… │ Adapters  ⚠    │ desktop         Desktop        1280 × 800     ⋯            │
│  Local… │                │ tablet          Tablet         1024 × 768     ⋯            │
│  Assets │                │ ┄ new ┄         [Mobile    ]   [390] × [844]  (unsaved)      │
│  Adapt… │                │ ─────────────────────────────────────────────────────────── │
│         │                │ Renaming a key changes identity and needs a reference check. │
│         │                │                                    [Discard]  [Save changes] │
└─────────┴────────────────┴──────────────────────────────────────────────────────────────┘
```

Adapters section:

- an ordered list (drag handle plus ↑/↓ buttons for keyboard users);
- per adapter: id (mono), module specifier, resolved version, status badge;
- a config form generated from the adapter's schema;
- an invalid set shows a fault `UAlert` with package-manager repair guidance (copyable command text), and Catalog and Preview are disabled (Part 8 10b).

### Locales (desktop)

```
 Locales                     [+ Locale]   ⌕ Filter keys   ☐ Only reminders (3)
 ────────────────────────────────────────────────────────────────────────────────────
 Key (mono)          en-US ★ primary            zh-TW
 checkout.title      Payment failed             付款失敗
 pay.cta             Pay now                    ⎵ whitespace only ⚠        ← cell marker (Part 5)
 promo.title         Spring sale                ∅ empty ⚠
 ────────────────────────────────────────────────────────────────────────────────────
 Edits are saved per locale file.                         2 unsaved · [Discard] [Save zh-TW]
```

### Assets (desktop)

```
 Assets   [Upload]   ⌕   Type ▾   Usage ▾ (Unused)        ▦ Grid / ☰ List
 ┌────────┐ ┌────────┐ ┌────────┐
 │ thumb  │ │ thumb  │ │  ⚠     │   logo.svg · image/svg+xml · 2.1 KB · used by 3
 └────────┘ └────────┘ └────────┘   card-bg.png · unused (badge neutral)
 Detail slideover: preview, metadata form, Replace content…, used by (Views/Widgets, links), diagnostics
```

### UX Flows (desktop): graph plus selected-item editor

```
┌ Flows: Checkout recovery ─────────────────────────────────── [▶ Play prototype] ┐
│ canvas (graph)                                                     │ Step         │
│   ┌─────────────┐  submit.click   ┌──────────────┐                 │ View: Checkout│
│   │▶ Cart        │───────────────►│ Payment error │──retry.click─┐  │ Variant: error│
│   │ base         │                │ error-state  │◄─────────────┘  │ Transitions 2 │
│   └─────────────┘                └──────────────┘                 │ #retry.click → │
│        ⚠ unreachable: "Receipt"                                    │   Payment err │
└────────────────────────────────────────────────────────────────────┴──────────────┘
```

### Prototype player

The player opens full-canvas, reusing the frame. A step strip runs across the top ("Cart › Payment error › …") with Restart and Exit. Available transitions show as "Next: click #retry-button". It is a fresh Runtime on every step entry (Part 6 #6). Tablet supports playback and read-only graph viewing. Mobile shows the Flow as an ordered step list with View thumbnails (read).

## 6. Component choices

| Element | Component |
|---|---|
| Page shell | `UDashboardPanel`, with `UNavigationMenu` (vertical) as the section index |
| Forms | `UForm` with a schema (zod or valibot) and `UFormField` for every field (label, help, error). Section-level Save |
| Viewport and theme rows | `UTable` with inline `UInput` / `UInputNumber` in edit mode. Key edits open a `UModal` reference-impact check ("3 Reviews, 2 evidence records refer to `desktop`") that requires explicit acknowledgement (Part 10: key change is identity-changing) |
| Adapter order | List with drag handle and keyboard ↑/↓ `UButton`s |
| Locale table | `UTable` (virtualized rows) with editable cells (`UInput` on focus). Reminder markers use `UBadge` (warning, subtle) for "empty" and "whitespace only" |
| New locale | `UModal` with locale code (`UInput`, BCP 47 validation) and "Copy keys from" (`USelect`) |
| Assets | Grid of `UCard` or list `UTable`. Upload via `UFileUpload`. Details in a `USlideover` |
| Flow graph | Graph library projection (open dependency: `@vue-flow/core` or equivalent). Nodes are styled as UCard-like boxes: View name, Variant mono chip, entry marker. Edges are labelled with mono `widgetId.event` |
| Step / transition editor | Right `UDashboardPanel` with `USelectMenu` for View, Variant (with "Base state"), Widget and Event (from Catalog metadata) |
| Validation | Inline `UAlert`s on the graph (unreachable, ambiguous trigger, missing target) plus node badges |
| Player | The canvas frame, a `UBreadcrumb` step strip and `UButton`s |

## 7. States

| State | Treatment |
|---|---|
| Unsaved changes | Section footer: "{n} unsaved" plus Discard and Save. Navigating away prompts with an inline `UModal` ("Leave without saving?") |
| Saving | Button loading. Fields read-only |
| Saved | Toast "Saved". Revision updated silently |
| Revision conflict | Caution `UAlert` at the top of the section: "Settings changed since you opened them." with "Reload theirs" and "Compare". Never auto-merge. Drafts are kept until discarded |
| Server diagnostics | `UAlert` (error) listing each diagnostic with its path (mono). Fields with a path get the inline error too |
| Empty locales | `UEmpty`: "No locales yet" / "Add the primary locale to start translating." with "Add locale" |
| Empty assets | `UEmpty`: "No assets yet" / "Upload images or icons your Views reference." with "Upload" |
| Empty flows | `UEmpty`: "No UX Flows yet" / "A Flow connects Views into a playable path. Ask your agent to `create_flow`, or create one here." with "New Flow" (desktop) |
| Invalid Flow | Graph still renders. Invalid parts are fault-badged. The Player is disabled with the reason: "Fix 2 problems to play this Flow." |
| Asset invalid (type or digest mismatch) | Tile fault badge. Detail shows diagnostics. Referencing Views are listed |
| Tablet | Settings, Locales and Assets are read-only, with an edit hint "Edit on desktop". Flows support play plus read-only graph |
| Mobile | Read-only lists |
| Publication mode | All read-only. Upload, Save and Edit are hidden |

## 8. Keyboard

| Keys | Action |
|---|---|
| `⌘S` | Save the current section |
| `Esc` | Cancel the edit or close the slideover |
| Arrow keys / `Enter` / `Esc` (Locale table) | Move between cells / edit / cancel |
| `Tab` | Next cell |
| Arrow keys (Flow graph, with a node focused) | Move focus to the connected node along edges |
| `Enter` / `P` | Edit the node / play from here |

## 9. Accessibility

- Every field has a visible label (`UFormField`). Help text is linked with `aria-describedby`.
- The Locale table is a grid with row and column headers. Reminder markers are text badges, not color.
- The Flow graph has a parallel accessible representation: a list of steps with their outgoing transitions, toggleable as "List view". This is also the mobile view.
- Drag-to-reorder always has a button alternative.

## 10. Copy

| Key | en-US | zh-TW |
|---|---|---|
| settings.title | Workspace settings | Workspace 設定 |
| settings.general / viewports / themes / adapters | General / Viewports / Themes / Adapters | 一般／檢視區／主題／Adapter |
| settings.keyChange | Renaming a key changes its identity. Check references first. | 重新命名鍵會變更其識別，請先檢查參照。 |
| settings.unsaved | {n} unsaved | {n} 項未儲存 |
| settings.conflict | Settings changed since you opened them. | 開啟後設定已有變更。 |
| adapters.invalid | The Adapter set is invalid. Preview and Catalog are paused until it's fixed. | Adapter 組合無效，修正前會暫停預覽與 Catalog。 |
| adapters.repair | Run this in your project to fix it: | 請在專案中執行以下指令修正： |
| locales.title | Locales | Locale |
| locales.primary | Primary | 主要 Locale |
| locales.onlyReminders | Only reminders | 只顯示提醒 |
| locales.empty / whitespace | Empty / Whitespace only | 空字串／只有空白 |
| assets.title | Assets | Asset |
| assets.upload / replace | Upload / Replace content… | 上傳／取代內容… |
| assets.unused | Unused | 未使用 |
| assets.usedBy | Used by {n} | 被 {n} 處使用 |
| flows.title | UX Flows | UX Flows |
| flows.play | Play prototype | 播放原型 |
| flows.restart / exit | Restart / Exit | 重新開始／離開 |
| flows.next | Next: {event} | 下一步：{event} |
| flows.unreachable | Unreachable step | 無法抵達的步驟 |
| flows.cantPlay | Fix {n} problems to play this Flow. | 修正 {n} 個問題後才能播放此 Flow。 |
| common.editOnDesktop | Edit on desktop | 請在桌面版編輯 |

## 11. Constraints and open decisions

- **Graph library** is a new runtime dependency (not a schema decision). Pick one that renders with DOM/SVG so it can be themed with the Nuxt UI variables.
- **Theme registry editing** must respect Adapter compatibility diagnostics (Part 10). The UI shows them and never offers a fallback.
- **Settings** were "file/config driven initially" in the IA decision (Part 1). `update_workspace_settings` now exists, so the page is an authoring convenience over the same operation, not a second source of truth.
