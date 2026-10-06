---
version: 1
slug: "app-composables-useworkbenchfeedback-ts"
primary_target: "app/composables/useWorkbenchFeedback.ts"
related_targets: ["app/components/workbench/WbEmpty.vue","app/components/workbench/WbErrorState.vue","app/components/workbench/WbConflictAlert.vue"]
---

# Shape brief (h): Empty, error and loading states

Mode: **Operate**. Visual authority: `DESIGN.md`. Target: shared state components (`WbEmpty`, `WbErrorState`, `WbConflictAlert`, `WbSkeleton*`) used by every surface, plus `useWorkbenchFeedback` from the foundation branch.

## 1. Job and audience

Agents write into a Workspace that the human did not set up by hand. So the Workbench constantly meets edge states:

- a brand-new Workspace;
- an adapter that cannot resolve;
- a View deleted by an agent;
- a thread whose Widget vanished;
- a revision conflict because the agent wrote while the human was typing.

Each state must say what happened, why it matters, and the one next action, in the precise-instrument voice. Internals appear only when something is wrong, and then they are exact.

## 2. Outcome and proof

- One vocabulary everywhere:
  - `UEmpty` for nothing-here;
  - `UAlert` for persistent, in-place problems;
  - toast for completed or failed operations and for "navigation didn't happen";
  - `USkeleton` for loading.
- No raw transport strings (`[POST] "/api/…": 422`) ever reach the user. Diagnostics render as a list with their mono `code` and path (foundation `describeFetchError`).
- Error styling is never green. Success styling is never used for failures.
- Every empty state teaches the next action. Every error offers a repair or retry path. Nothing is auto-repaired (PRODUCT.md principle 3).

## 3. Selected direction

Quiet, specific and repairable. Empty states use a 20px Lucide icon in `text-dimmed`, a Title-size heading, one Body sentence and at most two actions (one primary). They have no illustrations, no mascots and no "Oops!". Errors lead with what failed in plain words. Exact codes and IDs sit in a "Details" disclosure with copy buttons.

## 4. Scope and boundaries

- **In scope:** the state catalogue below, shared components, copy, and placement rules.
- **Untouched:** server error codes and diagnostic shapes.
- **Anti-goals:**
  - blocking modals for recoverable errors;
  - spinners centered over content (use skeletons);
  - generic "Something went wrong" without a cause, except as a final fallback with a Details disclosure.

## 5. Placement rules

| Kind | Where | Component |
|---|---|---|
| Nothing to show in a region | In that region | `UEmpty` (size `md`, or `sm` in panels) |
| A persistent problem with this thing | Top of the affected region, non-modal, stays until fixed or left | `UAlert` subtle (caution or error) |
| Operation result | Toast, bottom-right on desktop, top on mobile | `useToast` (success: 4s; error: persistent until dismissed, with "Details") |
| Navigation target missing | Toast. The current state is kept (Part 3) | `useToast` (caution) |
| Global connectivity | Under the navbar, full width | `UAlert` (error) plus Retry |
| Loading | In place, matching the final layout | `USkeleton` |
| Long operation (capture, export) | Inline progress in the triggering surface | `UProgress` |

## 6. State catalogue

| Surface | State | Title / body (en-US) | Action(s) |
|---|---|---|---|
| Overview | No Views | **No Views yet** / Ask your agent to create one with `create_view`, then refresh. | Copy MCP endpoint · Refresh |
| Views | Filter no match | **No Views match "{q}"** / Try a different name or feature. | Clear filter |
| View canvas | No View selected (desktop `/views`) | **Pick a View** / Choose one from the list to review it. | none (list is beside it) |
| View canvas | Variant invalid | **This Variant can't run** / {n} problems in its overrides. | Switch to base state · See problems |
| View canvas | Adapter set invalid | **Preview unavailable** / The Adapter set is invalid, so nothing can render. | Open Adapters |
| View canvas | Adapter unresolved (audit E1) | **Adapter "{id}" couldn't load** / Check that the package is installed. | Copy repair command · Retry |
| View canvas | Preview session lost | (chip) **Preview stopped** | Retry |
| View canvas | Mapping unmeasurable | (inline alert) **Precise highlight paused** / The preview can't be measured right now. | none (self-recovers) |
| Comments | None on View | **No comments yet** / Press C and click anything in the View to comment. | Start commenting |
| Comments | Unplaced threads | (tray) **{n} comments can't be placed** / Their Widgets are no longer in this View. | Re-anchor · Open |
| Reviews | None in Workspace | **No Reviews yet** / Comments made on a View's canvas show up here. | Go to Views |
| Reviews | Filter no match | **No threads match these filters.** | Clear filters |
| Reviews | All caught up | **Nothing waiting for review** / {n} resolved. | Show resolved |
| Inspector | Nothing selected | **Select a Widget** / Click a Widget in the View or the Layers list. | none |
| Readiness | No evidence | **No evidence yet** / Capture this View in the contexts you need. | Capture… (desktop) |
| Checks | Clean | **No findings** / Every View validates and no reminders are open. | none |
| Locales | None | **No locales yet** / Add the primary locale to start translating. | Add locale |
| Assets | None | **No assets yet** / Upload images or icons your Views reference. | Upload |
| Flows | None | **No UX Flows yet** / A Flow connects Views into a playable path. | New Flow (desktop) |
| Global | Workspace unreadable | **Can't open this Workspace** / {n} problems in `.uiux/workspace.json`. | Reload · Details |
| Global | Workspace schema older | **This Workspace uses an older format** / It's read-only until it's migrated. | Details (migration is explicit, outside the UI unless decided) |
| Global | Server unreachable | **Can't reach the UIUX server.** | Retry |
| Any form | Revision conflict | **This changed since you opened it.** / Your edits are kept. | Reload theirs · Compare |
| Any mutation | Validation rejected | **Couldn't save** / {first diagnostic message} (+ list) | Fix fields (focus first invalid) |
| Deep link | View gone | (toast) **View not found. Stayed on the current page.** | none |
| Deep link | Widget gone | (alert) **Widget {id} isn't in this View anymore.** | Select parent (when hinted) |
| Deep link | Thread gone | (toast) **Thread not found.** | Open Reviews |
| Publication | Read-only | (banner) **Published snapshot · read-only** | Dismiss |

## 7. Loading skeletons

| Surface | Skeleton |
|---|---|
| Sidebar View list | 8 rows (28px), with varying title widths |
| Widget tree | 10 rows with indents |
| Canvas | Frame outline at the viewport's aspect ratio, with a soft shimmer at the edge only. Never shimmer the View area for long |
| Right panel | Header plus 4 property rows |
| Reviews list | 6 two-line rows. Detail: 3 timeline items |
| Overview table | 5 rows |
| Locale table | 12 rows × locale columns |

Skeletons appear after a 150ms delay, so fast loads don't flash. They respect `prefers-reduced-motion` (no shimmer, static fill).

## 8. Components

- `WbEmpty` wraps `UEmpty` with icon, title, description and actions, and enforces at most two actions with one primary.
- `WbErrorState` wraps `UAlert`, taking `describeFetchError` output (message, diagnostics[], status). It renders the diagnostics list (mono code and path) and a "Details" `UCollapsible` with status code and request id when present.
- `WbConflictAlert` is a caution `UAlert` with Reload and Compare. Compare opens a side-by-side `UModal` (theirs and yours) for text fields.
- Toasts go through `useWorkbenchFeedback().success / error / notice`. Error toasts persist, and every toast is announced via the Nuxt UI live region.

## 9. Keyboard and accessibility

- On a failed submit, focus moves to the first invalid field. Otherwise it moves to the alert (`tabindex="-1"`, `role="alert"`) for global errors.
- `UEmpty` headings are real headings at the region's level, and actions are reachable in tab order.
- Toasts never steal focus. Error toasts include a "Details" button reachable with `F6` to the toast region.
- Everything works in both themes and both locales. zh-TW strings are checked for line wrap at a 320px panel width.

## 10. Copy (zh-TW for the catalogue)

| en-US | zh-TW |
|---|---|
| No Views yet / Ask your agent to create one with `create_view`, then refresh. | 還沒有 View／請你的 agent 使用 `create_view` 建立，再重新整理。 |
| No Views match "{q}" / Try a different name or feature. | 沒有符合「{q}」的 View／試試其他名稱或功能分類。 |
| Pick a View / Choose one from the list to review it. | 選擇 View／從清單中挑選一個開始審閱。 |
| This Variant can't run / {n} problems in its overrides. | 這個 Variant 無法執行／覆寫中有 {n} 個問題。 |
| Preview unavailable / The Adapter set is invalid, so nothing can render. | 無法預覽／Adapter 組合無效，因此無法繪製。 |
| Adapter "{id}" couldn't load / Check that the package is installed. | 無法載入 Adapter「{id}」／請確認套件已安裝。 |
| Preview stopped | 預覽已停止 |
| Precise highlight paused / The preview can't be measured right now. | 已暫停精確標示／目前無法量測預覽畫面。 |
| {n} comments can't be placed / Their Widgets are no longer in this View. | {n} 則留言無法定位／對應的 Widget 已不在這個 View 中。 |
| No findings / Every View validates and no reminders are open. | 沒有問題／所有 View 皆通過驗證，也沒有待處理的提醒。 |
| Can't open this Workspace / {n} problems in `.uiux/workspace.json`. | 無法開啟這個 Workspace／`.uiux/workspace.json` 中有 {n} 個問題。 |
| This Workspace uses an older format / It's read-only until it's migrated. | 這個 Workspace 使用舊版格式／完成遷移前為唯讀。 |
| Can't reach the UIUX server. | 無法連線到 UIUX 伺服器。 |
| This changed since you opened it. / Your edits are kept. | 開啟後內容已有變更。／你的編輯內容已保留。 |
| Reload theirs / Compare | 載入對方版本／比較 |
| Couldn't save | 無法儲存 |
| Thread not found. | 找不到討論串。 |
| Details | 詳細資料 |
| Retry | 重試 |

## 11. Constraints and open decisions

- **Migration UI** for older Workspace schema versions is not designed. Migration must be explicit and atomic (Part 1), and a UI for it would need its own task.
- **"Copy repair command"** text comes from server diagnostics (Part 8 10a). The UI never runs it.
