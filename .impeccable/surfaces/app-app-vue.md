---
version: 1
slug: "app-app-vue"
primary_target: "app/app.vue"
related_targets: ["app/layouts/default.vue","app/components/workbench/WorkbenchNavbar.vue","app/components/workbench/WorkbenchSidebar.vue","app/components/workbench/WorkbenchPreferences.vue","app/components/workbench/WorkbenchCommandPalette.vue","app/components/workbench/ReviewerIdentity.vue"]
---

# Shape brief (a): App shell and information architecture

Mode: **Operate**. Visual authority: `DESIGN.md` ("The Quiet Canvas"). Target: `app/app.vue`, `app/pages/**`, `app/components/workbench/WorkbenchHeader.vue`, `WorkbenchNav.vue`, `WorkbenchPreferences.vue`, plus the new layout components.

## 1. Job and audience

The shell has to work for three groups:

- A designer or PM opens the Workbench to review what an agent just authored.
- A developer flips over from an agent session to check the result.
- Either of them may be on an FHD desktop, a tablet on the couch, or a phone between meetings.

The shell's job is to get each of them to *the work waiting for their judgment* within one or two clicks, and then get out of the way of the canvas.

## 2. Outcome and proof

- The four accepted primary areas replace the nine equal tabs: **Overview, Views, UX Flows, Reviews** (Discussion #1, IA decision).
- Checks, Evidence and Handoff stop being destinations. They appear as readiness on Overview and inside each View (brief f).
- Workspace settings, Locales, Assets and Adapters move to a secondary "Workspace" group (brief g).
- Success means the following:
  - from a cold load, a reviewer reaches the first `ready-for-review` thread in at most two actions (Reviews → first row);
  - at 1920×1080 the canvas keeps at least 60% of the width;
  - nothing is hard-coded dark;
  - the shell is usable at 1024 and at 390.

## 3. Selected direction

The shell is built from Nuxt UI dashboard primitives in the Linear arrangement: one left sidebar carries both the IA and the current area's navigator. A slim top bar carries location and global actions, and the canvas fills the rest.

The sidebar's contextual section changes per area:

| Area | Sidebar context section |
|---|---|
| Views | View list. When a View is open, it becomes that View's Widget layers. |
| UX Flows | Flow list |
| Reviews | Saved filters |
| Overview | Nothing below the IA |

## 4. Scope and boundaries

- **In scope:** routes, the sidebar, the top bar, the preferences menu, the reviewer identity menu, the command palette, the responsive collapse rules, and the deep-link query contract.
- **Untouched:** the Preview host route (`/preview`) and all server routes.
- **Anti-goals:**
  - equal-weight tab grids;
  - a second nav column;
  - hiding the IA behind a hamburger on desktop;
  - chrome that follows the Preview theme.

## 5. Routes and deep links

Use a path-based SPA router with query-carried render context.

| Route | Purpose |
|---|---|
| `/` | Overview |
| `/views` | View index (desktop shows the most recent View; mobile shows a list) |
| `/views/:viewId` | View canvas. Query: `variant`, `locale`, `viewport`, `theme`, `widget`, `thread`, `panel` (`comments`, `inspect`, `spec`, `readiness`) |
| `/flows`, `/flows/:flowId` | Flow list and graph editor. `?play=1&step=<stepId>` opens the Prototype player |
| `/reviews` | Inbox. Query: `status`, `view`, `anchor`, `variant`, `domain`, `author`, `thread` |
| `/workspace/settings`, `/workspace/locales`, `/workspace/assets`, `/workspace/adapters` | Secondary authoring |

A Review deep link is `/views/<viewId>?variant=<name>&locale=..&viewport=..&theme=..&thread=<uuid>`. It opens the exact context and the thread's bubble. Chrome language and theme never ride in the URL.

## 6. Layout sketches

### Desktop, 1920×1080 (View open, sidebar expanded)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ design ▾ │ Views › Checkout › error-state            ⌘K Search   ⌂ Mei Lin ▾   ✻ ▾          │ 48 navbar
├────────────┬─────────────────────────────────────────────────────────────────┬───────────────┤
│ ◫ Overview │ ⧉ Variant: error-state ▾  ◎ en-US ▾  ▭ desktop 1280×800 ▾  ◐ light ▾ │ −  93%  + ⤢ │ 40 canvas bar
│ ▢ Views  12│─────────────────────────────────────────────────────────────────┤ Comments│Inspect│
│ ⌥ Flows   3│                                                                 │ Spec│Readiness│
│ ▤ Reviews 5│        ┌───────────────────────────────────────────────┐        │───────────────│
│────────────│        │                                               │        │ ▾ Ready (2)   │
│ ← All Views│        │            the View (only color here)         │        │  ◉ ML  Submit │
│ Checkout   │        │                        ◖ML                    │        │  ◉ AI Total  │
│ LAYERS  ⌕  │        │                                               │        │ ▾ Open (3)    │
│ ▾ root     │        │          ◖2                                   │        │  ○ JS  Copy…  │
│  ▾ header  │        └───────────────────────────────────────────────┘        │               │
│   · title  │                                                                 │               │
│  ▸ form  ◖2│                ╭───────────────────────────╮                    │               │
│────────────│                │ ↖ Select  ◖ Comment  ☐ ⎮ ⚲ │                    │               │
│ ✻ Workspace│                ╰───────────────────────────╯                    │               │
└────────────┴─────────────────────────────────────────────────────────────────┴───────────────┘
   264 px                         canvas ≈ 1316 px                                 340 px
```

(Glyphs are sketch shorthand only. The build uses Lucide icons per DESIGN.md.)

### Tablet, 1024×768 (sidebar as a 56px rail, right panel on demand)

```
┌────┬───────────────────────────────────────────────────────────────┐
│ ▣  │ Checkout ▾ · error-state ▾   en-US ▾  desktop ▾  light ▾  ☰ 5 │ 48 (context collapses into one row)
│ ◫  ├───────────────────────────────────────────────────────────────┤
│ ▢• │       ┌─────────────────────────────────────────────┐         │
│ ⌥  │       │                 View  ◖ML                   │         │
│ ▤5 │       │                                             │         │
│    │       └─────────────────────────────────────────────┘         │
│ ✻  │               ╭──────────────────────────────╮                │
│    │               │ ↖  ◖  ☐  ⎮ ⚲      −  80% +   │  44px targets  │
└────┴───────────────╰──────────────────────────────╯────────────────┘
 56px   "☰ 5" opens USlideover (right, 360px): Comments | Inspect | Spec | Readiness
```

### Mobile, 390×844

```
┌──────────────────────────────┐
│ ☰  Checkout        ⌕   (ML)  │ 48
├──────────────────────────────┤
│ [ Spec ][ Comments 5 ][ View ]│ UTabs
│                              │
│  Intent                      │
│  Let a shopper fix a failed  │
│  payment without re-entering │
│  …                           │
│                              │
├──────────────────────────────┤
│  ◫      ▢      ⌥      ▤ 5    │ 56 bottom nav + safe area
│ Overview Views Flows Reviews │
└──────────────────────────────┘
```

On mobile the default landing is **Reviews**: the triage job. Overview is one tap away.

## 7. Component choices (Nuxt UI 4)

| Region | Components |
|---|---|
| Shell | `UDashboardGroup` (storage `local`, key `uiux-shell`), `UDashboardSidebar` (`collapsible`, `resizable`, `:min-size`/`:max-size` per DESIGN.md, `mode="slideover"` below `lg`), `UDashboardPanel` for canvas and right panel (`resizable`), `UDashboardResizeHandle` |
| Top bar | `UDashboardNavbar` holding `UDashboardSidebarCollapse` / `UDashboardSidebarToggle`, `UBreadcrumb`, `UDashboardSearchButton`, and `UDropdownMenu` for reviewer identity and preferences |
| Primary nav | `UNavigationMenu orientation="vertical"` (`collapsed` bound to the sidebar), with items carrying `badge` counts |
| Workspace switcher (header) | `UDropdownMenu` showing the Workspace name and root path (mono) plus "Copy path". Switching Workspace is out of scope; one Workspace per server |
| Command palette | `UDashboardSearch` (`UCommandPalette`) with groups: Go to (areas), Views, Flows, Threads, Actions (Toggle comment mode, Fit, Switch theme, Switch language) |
| Preferences | `UDropdownMenu` with a radio group for Theme (System / Light / Dark through `useColorMode`) and Language (System / English / 繁體中文), plus Keyboard shortcuts (`UModal` listing `UKbd`) |
| Mobile bottom nav | `UNavigationMenu orientation="horizontal"` in a fixed footer, 4 items, icon over label |

## 8. States

| State | Treatment |
|---|---|
| Loading Workspace | Sidebar and canvas skeletons (`USkeleton`). The navbar renders immediately |
| Workspace invalid / unreadable | Full-panel `UEmpty` with an error icon, the diagnostics list, and "Reload". The IA stays visible (brief h) |
| Server unreachable | Persistent `UAlert` (error, subtle) under the navbar: "Can't reach the UIUX server." with Retry. Mutations are disabled |
| No reviewer identity yet | The identity menu shows "Set your name". The first comment attempt prompts inline (brief c) |
| Sidebar collapsed | Icon rail with tooltips. Counts become 8px dots with an `aria-label` carrying the count |
| Very narrow desktop window (< 1280) | Falls back to the tablet rules regardless of pointer type |

## 9. Keyboard

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl K` | Command palette |
| `G` then `O` / `V` / `F` / `R` | Go to Overview / Views / Flows / Reviews |
| `[` | Toggle sidebar |
| `]` | Toggle right panel |
| `?` | Shortcuts dialog |
| `⌘.` | Toggle Workbench theme light/dark (chrome only) |
| `F6` / `Shift F6` | Cycle landmarks: sidebar → canvas → right panel → navbar |

Shortcuts are ignored while focus is in a text field, and single-key shortcuts can be turned off in Preferences (WCAG 2.1.4).

## 10. Accessibility

- Landmarks: `nav` (sidebar, labelled "Primary"), `main` (canvas), `complementary` (right panel), `header` (navbar).
- `aria-current="page"` on the active nav item. Counts are read as "Reviews, 5 open".
- A skip link "Skip to canvas" is the first focusable element.
- The sidebar resize handle is keyboard operable (Nuxt UI handles it) and has a translated label.
- Language switching sets `<html lang>` (`en-US` / `zh-TW`) so the zh-TW typography overrides apply. The Preview iframe keeps its own `lang` from the render context.

## 11. Copy (key strings)

| Key | en-US | zh-TW |
|---|---|---|
| nav.overview | Overview | 總覽 |
| nav.views | Views | Views |
| nav.flows | UX Flows | UX Flows |
| nav.reviews | Reviews | Reviews |
| nav.workspace | Workspace | Workspace |
| nav.settings / locales / assets / adapters | Settings / Locales / Assets / Adapters | 設定／Locale／Asset／Adapter |
| shell.search | Search or jump to… | 搜尋或前往… |
| shell.skipToCanvas | Skip to canvas | 跳至畫布 |
| prefs.theme | Workbench theme | Workbench 主題 |
| prefs.themeHint | Changes the Workbench only, not the previewed View. | 只變更 Workbench，不影響預覽中的 View。 |
| prefs.language | Workbench language | Workbench 語言 |
| prefs.system | Match system | 跟隨系統 |
| identity.commentingAs | Commenting as {name} | 以 {name} 的身分留言 |
| identity.setName | Set your name | 設定你的名稱 |
| server.unreachable | Can't reach the UIUX server. | 無法連線到 UIUX 伺服器。 |

## 12. Constraints and open decisions

- **Glossary correction needed.** The foundation branch's glossary translates Variant (變體), Review (審查), Flow (流程), Locale (語系) and Asset (素材). Per the user, View, Variant, Widget, Review, Flow, Spec, Decision, Evidence, Handoff, Workspace, Locale, Asset and MCP stay in English (applied on `feat/workbench-foundation`).
- The reviewer identity is stored per browser (`localStorage`) and written as actor `{ type: "human", displayName }`. There is no roster and no auth (see PRODUCT.md Undecided).
- Tablet and mobile access to a *live* server conflicts with Part 1 item 12 (loopback-only, single user). Until it is resolved, the responsive layouts serve narrow desktop windows; mutation controls on touch layouts must not assume a reachable live server.
