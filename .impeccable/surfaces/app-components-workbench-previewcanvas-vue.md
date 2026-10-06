---
version: 1
slug: "app-components-workbench-previewcanvas-vue"
primary_target: "app/components/workbench/PreviewCanvas.vue"
related_targets: ["app/components/workbench/RenderContextControls.vue","app/components/workbench/WidgetTree.vue","app/components/workbench/CanvasOverlay.vue"]
---

# Shape brief (b): View canvas (zoom and fit, render-context bar, selection)

Mode: **Operate**. Visual authority: `DESIGN.md`. Target: `app/components/workbench/PreviewCanvas.vue`, `RenderContextControls.vue`, `WidgetTree.vue`, and the new overlay layer (`CanvasOverlay.vue`) and tool palette.

## 1. Job and audience

A reviewer opens a View to judge it in an exact render context:

- which Variant (state preset);
- which Workspace locale;
- which viewport preset;
- which Workspace theme.

They need to see the whole View, zoom into a detail, pick a Widget to inspect, and switch context without losing their place. They do this many times a session, so every switch must be one action and must never reset the chrome.

## 2. Outcome and proof

- The View renders at its canonical logical size inside the iframe, and only the outer frame scales. This invariant is kept from the incumbent.
- The four render dimensions sit in one bar and are always visible and labelled. The bar is the single source of truth for "what am I looking at", and it matches the URL query.
- Selection is shared between canvas and Widget tree:
  - clicking a Widget in Select mode selects it in the tree (auto-expanding ancestors);
  - selecting in the tree highlights it on the canvas, scrolling the View inside the iframe when needed (Part 3: select structurally first, highlight only when visible).
- The widget tree is no longer shallow. Full nesting with type icons, comment counts and diagnostic dots (audit finding).

## 3. Selected direction

This is a "quiet canvas": a recessed graphite ground, a crisp frame with Frame-lift shadow, and the View as the only colorful object. A floating tool pill sits bottom-center, in the Figma idiom. The render-context bar is a quiet toolbar row above the canvas, made of ghost select buttons with icon, label and value. Zoom controls sit at its right end.

The selected Widget wears the **blueprint label**: a 12px mono chip with type and id at its top-left, and a dimension chip below. Both are drawn by the Workbench overlay from iframe-reported geometry. The iframe never renders chrome.

## 4. Scope and boundaries

- **In scope:** the frame and stage, zoom and fit, the render-context bar, tool modes (Select, Comment, Interact), hover and selection overlays, tree ↔ canvas sync, the session status chip, and the unmeasurable-mapping state.
- **Out of scope here:** comment pins and bubbles (brief c), the Inspector and Spec content (brief e).
- **Untouched (protocol):**
  - the iframe owns hit testing and geometry;
  - geometry revisions and stale-reply rejection (Parts 2 and 3);
  - `ResizeObserver` and rAF-coalesced remeasurement only while an overlay is active;
  - no heuristic overlay when the mapping can't be measured.
- **Anti-goals:**
  - a fake window title bar with three dots (removed);
  - "Real Iframe Boundary" and other protocol labels in default view;
  - a transparent capture layer over the iframe;
  - chrome theme following the Preview theme.

## 5. Layout sketch (desktop canvas region)

```
┌ canvas bar (40px, UDashboardToolbar) ──────────────────────────────────────────────────────────┐
│ ⧉ Variant  error-state ▾ │ ◎ Locale  zh-TW ▾ │ ▭ Viewport  desktop · 1280×800 ▾ │ ◐ Theme  dark ▾ │
│                                                          ● Live          −   93% ▾   +   ⤢ Fit │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · │
│ ·      Button · #checkout-submit                                                             · │
│ ·     ┌──────────────────────────────────────────────────────────────────────┐               · │
│ ·     │   (the View, rendered by the Design System in its own theme/locale)  │               · │
│ ·     │                                                                      │               · │
│ ·     │                ┏━━━━━━━━━━━━━━━━━┓   ← 1.5px Iris selection          │               · │
│ ·     │                ┃   Pay now       ┃                                   │               · │
│ ·     │                ┗━━━━━━━━━━━━━━━━━┛                                   │               · │
│ ·     │                     320 × 44                                         │               · │
│ ·     └──────────────────────────────────────────────────────────────────────┘               · │
│ ·                       ╭────────────────────────────────────────╮                           · │
│ ·                       │ [↖ Select V] [◖ Comment C] [☐ Interact I] │ ⚲ Filter ▾ │ ◉ Pins │     · │
│ ·                       ╰────────────────────────────────────────╯                           · │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

On tablet the canvas bar collapses into the navbar row as a compact context summary ("error-state · zh-TW · desktop · dark ▾"). Tapping it opens a `UPopover` with the four selects stacked. On mobile the View tab shows the frame fit-to-width, read-only, with pins. The context summary is a `UDrawer` trigger.

## 6. Component choices

| Element | Component |
|---|---|
| Canvas bar | `UDashboardToolbar` |
| Variant | `USelectMenu`, searchable when there are more than 8. Items: "Base state" (sentinel value; reka items cannot use `''`), then named Variants. Invalid Variants render disabled with an error icon and the reason in the item description |
| Locale | `USelect` over discovered Workspace locales, with a primary-locale badge |
| Viewport | `USelect` showing label plus mono `W×H` |
| Theme | `USelect` over Workspace theme IDs. An Adapter-incompatible theme is disabled with a reason (Part 10: diagnostic, no fallback) |
| Zoom | `UFieldGroup`: ghost `UButton` −, a `UDropdownMenu` showing the percentage (Fit, 50, 75, 100, 150, 200), ghost `UButton` +, and ghost `UButton` Fit |
| Session chip | `UBadge` (neutral) "Live". It becomes caution "Reconnecting…" or error "Preview stopped", with a `UPopover` holding details (session, generation) one click away |
| Tool pill | `UFieldGroup` of ghost `UButton`s with `UTooltip` and `UKbd` |
| Stage | Custom: a scroll container, the scaled frame and the iframe. No component fits; keep `PreviewCanvas.vue` |
| Overlay | Custom absolutely positioned layer above the iframe, `pointer-events: none` except on pins and chips. It never covers the iframe for input |
| Unmeasurable mapping | `UAlert` (caution, subtle, inline at the top of the stage): "Precise highlight paused. The preview is transformed in a way that can't be measured." Selection continues structurally in the tree |

## 7. Behavior

**Fit and zoom**
- On load and on viewport change, Fit runs. It scales to the largest step at or below fit, never above 100% unless the user zooms.
- A manual zoom is remembered for this View and viewport in session memory.
- Zooming keeps the canvas center, or the selected Widget's center when one exists.
- Ctrl/⌘ + wheel zooms only over the canvas gutter. Over the iframe the wheel scrolls the View itself; no capture layer intercepts it. Pinch on touch also works only on the gutter.
- At zoom levels above fit, the stage scrolls natively.

**Render-context switching**
- Changing the Variant creates a fresh Runtime (Part 1). The overlay hides pins and selection until the new geometry arrives (via a skeleton shimmer on the frame edge, ≤ 300ms typical), then restores selection if the Widget still exists.
- Changing locale, viewport or theme is a presentation change that keeps runtime state (Part 10). Selection persists, and the overlay re-projects.
- The URL query updates with `replace` (not `push`) for context changes, and with `push` for View and thread changes.

**Tools**
- **Select (V, default):** hover shows a 1px Iris/60 outline and a small mono type chip. Click selects (blueprint label and Inspector). Escape clears.
- **Comment (C):** see brief c. A Marker inset line runs along the top of the canvas, and hover shows a dashed Marker outline.
- **Interact (I):** the View receives events normally. Prototype transitions may fire. No hover overlays. Pins remain visible but dim to 40%, to signal they are not interactive targets.

**Selection sync**
- Tree → canvas: select, then ask the iframe to reveal the Widget (scroll into view), then highlight once it is visible.
- Hidden or zero-size Widgets show "Not visible in this state" in the Inspector, with no highlight.

## 8. States

| State | Treatment |
|---|---|
| Loading View | Frame skeleton at the viewport's aspect ratio. Context bar enabled |
| Preview session connecting | "Connecting preview…" chip. Tools disabled with a tooltip giving the reason |
| Session lost / generation replaced | Overlay cleared. Targeting mode kept if active (Part 3). Chip turns caution with Retry |
| Variant invalid | Frame replaced by `UEmpty`: "This Variant can't run." plus the diagnostics list, "Switch to base state", and "Open in Checks" |
| Adapter set invalid | Frame replaced by `UEmpty` (error): "Preview unavailable. The Adapter set is invalid." with "Open Adapters". Tree and Spec stay usable (Part 8, 10b) |
| Missing Widget from a deep link | Persistent inline `UAlert` above the tree: "Widget #x isn't in this View anymore." (Part 3). The View opens normally |
| Missing View from a deep link | Toast "View not found. Stayed on the current page." No navigation |
| Publication mode | Same canvas. Tools: Select and Interact only. Pins are visible read-only |

## 9. Keyboard

| Keys | Action |
|---|---|
| `V` / `C` / `I` | Select / Comment / Interact tool |
| `Esc` | Exit Comment mode, clear the selection, or close a menu (innermost first) |
| `Shift 1` or `⌘0` | Fit |
| `Shift 0` | 100% |
| `⌘=` / `⌘−` | Zoom in / out (captured only while focus is in the Workbench) |
| `Alt ↑` / `Alt ↓` | Select parent / first child Widget |
| `Alt ←` / `Alt →` | Previous / next sibling |
| `Shift V` | Open the Variant menu (type-ahead) |
| `Shift L` / `Shift T` | Locale / theme menu |

## 10. Accessibility

- The iframe has a `title`: "Preview of {view} · {variant} · {locale} · {viewport} · {theme}".
- The canvas region is labelled. Context changes are announced politely ("Variant: error-state").
- The selection outline is not the only signal: the Inspector, the tree selection, and a live-region announcement ("Selected Button #checkout-submit, 320 by 44") all reflect it.
- The keyboard path to every Widget is the tree. Canvas pointer selection is an accelerator, not the only path.
- The tool pill is a toolbar (`role="toolbar"`, roving tabindex). The active tool is `aria-pressed`.
- Contrast: the selection outline is Iris at 5.37:1 on the canvas. Over the View content, a 1px panel-colored halo keeps it visible on any View color.

## 11. Copy

| Key | en-US | zh-TW |
|---|---|---|
| ctx.variant / base | Variant / Base state | Variant／基本狀態 |
| ctx.locale | Locale | Locale |
| ctx.viewport | Viewport | 檢視區 |
| ctx.theme | Theme | 主題 |
| ctx.themeHint | Theme of the previewed View | 預覽中 View 的主題 |
| tool.select / comment / interact | Select / Comment / Interact | 選取／留言／互動 |
| zoom.fit | Fit | 符合畫布 |
| session.live / reconnecting / stopped | Live / Reconnecting… / Preview stopped | 即時／重新連線中…／預覽已停止 |
| canvas.variantInvalid | This Variant can't run. | 這個 Variant 無法執行。 |
| canvas.switchToBase | Switch to base state | 切換為基本狀態 |
| canvas.mappingPaused | Precise highlight paused. The preview can't be measured right now. | 已暫停精確標示。目前無法量測預覽畫面。 |
| canvas.widgetMissing | Widget {id} isn't in this View anymore. | Widget {id} 已不在這個 View 中。 |
| canvas.viewMissing | View not found. Stayed on the current page. | 找不到 View，已停留在目前頁面。 |
| canvas.notVisible | Not visible in this state | 在此狀態下不可見 |

## 12. Constraints and open decisions

- Cursor feedback inside the iframe during Comment mode (a crosshair) would require the runtime to set a cursor on its own document. Confirm this counts as "richer inspection behavior" enabled by the mode notification (Part 1), not as review chrome. Without it, the Marker canvas line and the hover outline carry the mode.
- Dot grid visibility and zoom memory are session-only. Nothing is persisted.
