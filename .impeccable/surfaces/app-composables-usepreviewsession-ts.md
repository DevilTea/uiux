---
version: 1
slug: "app-composables-usepreviewsession-ts"
primary_target: "app/composables/usePreviewSession.ts"
related_targets: ["app/components/workbench/CanvasOverlay.vue","app/components/workbench/CommentPin.vue","app/components/workbench/CommentComposer.vue","app/components/workbench/ThreadBubble.vue","app/composables/useCanvasComments.ts"]
---

# Shape brief (c): Figma-style comments on the canvas

Mode: **Operate**. Visual authority: `DESIGN.md` (signature: the annotation layer). Target: the new `CanvasOverlay.vue`, `CommentPin.vue`, `CommentComposer.vue`, `ThreadBubble.vue` and `useCanvasComments.ts`, plus the Comments tab of the right panel. This replaces the sidebar-only `ReviewsPanel` flow on the canvas.

## 1. Job and audience

A designer or PM sees something wrong in the View and wants to say so *right there*. Today it takes four or more clicks through a sidebar form, and no pins appear on the canvas. The target is the Figma gesture:

1. press `C`;
2. click the thing;
3. type;
4. press `⌘↵`.

Afterwards, everyone sees a pin on that Widget. Clicking a pin opens the conversation, where they can reply, resolve a submitted fix, or reopen it.

## 2. Outcome and proof

- Creating a comment takes **one keystroke, one click, typing and one keystroke**, with no form page.
- All threads for the current View and Variant scope render as pins. The default filter is open plus ready-for-review.
- Resolve and reopen happen inline in the bubble, under the accepted lifecycle:
  - **Resolve** is offered only on `ready-for-review` and names the submission it accepts (Part 7 #7);
  - an `open` thread offers **Reply**, plus a secondary "Submit for review…" for the human-submission case.
- Persistence stays exactly `{ viewId, widgetId }` plus `variantNames`. The click point is transient (Part 3, 2026-10-02). The iframe hit-tests; there is no transparent capture layer (Part 3).
- **Phase 2 slot.** Pin placement goes through one resolver, `resolvePinPoint(thread, geometry) → { x, y, source }`:
  - in Phase 1, `source` is `default` (derived from runtime geometry) or `session` (the in-memory click point for threads created in this tab);
  - in Phase 2, `source: 'hint'` reads the proposed `displayHint.pin` normalized offset, with no other code changes.

## 3. Selected direction

The direction is a Figma-faithful annotation layer in Marker magenta:

- teardrop pins with initials, floating above the View;
- an inline composer bubble that opens at the click;
- a thread bubble with a compact typed timeline.

The comment tool is a mode, not a modal. Its only ambient signals are a Marker line along the canvas top and a dashed Marker hover outline that the iframe resolves.

## 4. Scope and boundaries

- **In scope:**
  - the comment tool and mode;
  - hover target and click-to-compose;
  - pin rendering for all threads, plus clustering;
  - the thread bubble (replies, resolve, reopen, overflow actions);
  - the pin filter (open / ready / resolved);
  - stale, off-screen, invalid and out-of-scope anchor states;
  - the Comments tab list synced with pins;
  - non-pointer creation paths;
  - tablet and mobile behavior.
- **Out of scope:** the global Reviews inbox (brief d), evidence bundle authoring UI depth (brief f), and the Phase 2 schema itself.
- **Untouched:** Review schema, MCP tools, and the targeting protocol (`targetingInteractionId`, generation teardown, Escape authority, touch tap-commit).
- **Anti-goals:**
  - drawing a pin at a guessed position for an invalid anchor;
  - auto-rebinding;
  - a comment form in a modal;
  - pins inside formal captures;
  - persisting the click point anywhere, including `localStorage`.

## 5. Interaction sequence (desktop)

```
 Press C ─► Workbench enters targeting (protocol state, new targetingInteractionId)
            Canvas top gets a 2px Marker line; tool pill shows Comment active
 Hover   ─► iframe hit-tests, reports candidate {widgetId, geometry}
            Workbench draws a dashed Marker outline + chip "Comment on Button"
 Click   ─► iframe reports final target {widgetId, clickPoint (inner-viewport px, transient)}
            Workbench drops a PENDING pin (dashed) at the click point
            and opens the composer bubble anchored to the pin tip (UPopover, virtual reference)
 Type    ─► textarea (focus already inside); Variant scope defaults to "This Variant"
            when a named Variant is active, otherwise "All Variants"
 ⌘↵      ─► create_review_thread with {anchor:{viewId,widgetId}, variantNames, message, actor}
            Pin turns solid with the author's initials; bubble becomes the thread bubble
            Session memory keeps the normalized click offset for this tab only
 Esc     ─► first Esc: close composer (if empty) / ask to discard (if typed, inline in the bubble)
            second Esc: exit Comment mode (Workbench owns the exit; iframe only signals intent)
```

After creating a comment, the tool **stays in Comment mode**, as in Figma, so a reviewer can drop several notes. A setting, "Return to Select after commenting", is available in Preferences.

## 6. Layout sketches

### Composer at the click point

```
            ◖┄┄┐  ← pending pin (dashed), tip exactly at the click point
              ╭────────────────────────────────────────────╮
              │ Button · #checkout-submit     This Variant ▾│  12px label + mono id; USelect scope
              │ ┌────────────────────────────────────────┐ │
              │ │ Label should say "Pay NT$1,280"        │ │  UTextarea autoresize, 14px
              │ └────────────────────────────────────────┘ │
              │ (ML) Commenting as Mei Lin       Cancel  [Comment ⌘↵] │
              ╰────────────────────────────────────────────╯ 320px, 12px radius, Overlay shadow
```

### Thread bubble (ready-for-review)

```
   ◖ML•  ← pin with blue ready badge, 2px Iris ring when open
     ╭──────────────────────────────────────────────╮
     │ ◉ Ready for review   Button · #checkout-submit  ⋯ │  ⋯ = Copy link · Re-anchor · Promote to Decision
     │──────────────────────────────────────────────│      · Open in Reviews · Copy thread ID
     │ (ML) Mei Lin · 2h                             │
     │ Label should say "Pay NT$1,280"               │
     │ (AI) Claude (agent) · 14m                     │
     │ Updated the label binding.                    │
     │ ┊ Submitted for review · i18n, IR · 2 evidence ▸│  submission row (expand → evidence refs)
     │──────────────────────────────────────────────│
     │ ┌ Reply… ─────────────────────────────────┐   │
     │ └─────────────────────────────────────────┘   │
     │            Reopen        [✓ Resolve]          │  Resolve accepts submission 3f2a…
     ╰──────────────────────────────────────────────╯ max-height 60vh, timeline scrolls
```

### Pins, clusters and off-screen anchors

```
 ┌ frame ──────────────────────────────────────────────┐
 │   ◖ML        ◖JS•                       ◖+4  ← cluster│
 │                                                     │
 │   (Widget scrolled out of the View) ─────────► ◖↘ 2  │ ← edge pin clamped to frame edge
 └─────────────────────────────────────────────────────┘
 ╭ ⚠ 2 comments can't be placed ▸ ╮  ← unplaced tray, bottom-left of canvas
```

### Comments tab (right panel), synced with pins

```
 Comments                          ⚲ Open, Ready ▾
 ─────────────────────────────────────────────────
 ▾ Ready for review · 2
   ◉ (AI) Totals row misaligned          14m   ◖ 1
   ◉ (ML) Pay label copy                 2h    ◖ 3
 ▾ Open · 3
   ○ (JS) Error text too long in zh-TW   1d    ◖ 2
 ▾ Can't be placed · 2                          ⚠
   ⚠ #promo-banner (removed) "Banner…"   3d    Re-anchor
 ▸ Other Variants · 4
```

Hovering a row highlights its pin, and clicking it pans to the pin and opens its bubble. Pressing `J` / `K` in the list moves between threads.

## 7. Pin placement (Phase 1)

| Thread situation | Placement |
|---|---|
| Created in this tab | The session-memory click offset, normalized to the Widget's current bounds, re-projected on every geometry update |
| Otherwise | Default point: the pin tip sits at the Widget's top-right corner, inset 4px inside the bounds, so it never covers the Widget's leading label. Several threads on the same Widget fan out leftward at 20px steps. With three or more, they become a count cluster |
| Widget is RootShell `root` (blank-area clicks) | The default point is the frame's top-left inset of 16px, with the same fan-out. This is the stacking pain Phase 2 solves |
| Widget off-screen in the iframe | An edge pin clamped to the nearest frame edge, with a direction chevron and count. Click asks the iframe to reveal the Widget, then opens the bubble |
| Widget hidden or zero-size in this state | Not drawn on the canvas. Listed under "Not visible in this state" in the Comments tab |
| Anchor invalid (Widget missing from IR) | Never drawn. Listed in the unplaced tray and the tab with its historical hint (last label or path snapshot if available) and **Re-anchor** |
| Named Variant in `variantNames` missing | Pin drawn if the Widget resolves, with a fault badge "Variant missing". Diagnostic in the bubble header |
| Thread scoped to other Variants | Not drawn. Listed under "Other Variants · n", with a "Switch to {variant}" row action |
| Mapping unmeasurable (non-affine) | All pins hidden. Inline notice (brief b). The list stays usable |
| Resolved | Hidden unless the filter includes Resolved. Then a 24px graphite teardrop with a check |

Pins re-project per animation frame only while the overlay is active (Part 3 rAF rule). They never tween between positions.

## 8. Non-pointer and alternative paths (required)

- In the Widget tree, focus a row and press `C`, or use the context menu (`UContextMenu`) "Comment on this Widget". The composer opens at that Widget's default pin point.
- Inspector: the "Comment" button in the selected Widget header does the same.
- Pins are focusable buttons in reading order. `Tab` moves through them, `Enter` opens the bubble, and `Esc` returns focus to the pin.
- From the Comments tab, `Enter` on a row opens its bubble. `R` focuses the reply field and `⌘↵` sends.

## 9. Tablet and mobile

**Tablet (touch, ≥ 768)**
1. Tap the Comment tool, then tap the target. A tap commits; there is no hover preview (Part 3 touch rule).
2. The composer opens as a bubble.
3. When the virtual keyboard opens (a `visualViewport` resize), the composer docks as a bottom `UDrawer` and keeps a target chip, "On Button · #checkout-submit · tap to show". The pin stays visible above the keyboard by auto-panning.

Thread bubbles behave the same way. Pins are 32px with a 44px hit area.

**Mobile (< 768)**
- **View tab:** a fit-to-width, read-only frame with pins. A tap on a pin opens the thread in a `UDrawer` sheet (snap points 50% / 90%).
- **Comments tab:** a list grouped by status. Replying, resolving `ready-for-review` threads and reopening are all available.
- Creating *new* canvas comments is off by default on mobile (an open decision; precise targeting at about 30% scale is unreliable). The Comment tool is hidden.

## 10. States

| State | Treatment |
|---|---|
| No threads on this View | Comments tab `UEmpty`: "No comments yet" plus "Press C and click anything in the View to comment." with a "Start commenting" button |
| All resolved | The pin layer shows nothing. The tab says "All caught up · 6 resolved" with "Show resolved" |
| Posting | Send shows a loading state and the textarea is read-only. Optimistic pin in the pending style |
| Post failed | Inline `UAlert` (error) inside the bubble with the diagnostic. Text is kept, with Retry. Never lost |
| Revision conflict (thread changed) | Inline caution in the bubble: "This thread changed." The timeline is refreshed and the reply text is kept. Retry is explicit |
| No reviewer name | The first send turns the footer into "Your name" `UInput` plus "Comment". It is saved locally |
| Session reconnecting | Pins hidden. A "Reconnecting preview…" chip. The composer keeps its text (targeting interaction cancelled per Part 3) |

## 11. Keyboard summary

| Keys | Action |
|---|---|
| `C` | Comment tool (toggle) |
| `Shift C` | Show or hide pins |
| `Esc` | Close bubble, or exit Comment mode |
| `⌘↵` | Send comment or reply |
| `J` / `K` | Next / previous thread (list or pins) |
| `R` | Reply to the open thread |
| `⇧⌘↵` | Resolve, when ready-for-review |
| `⇧⌘O` | Reopen |
| `⌘L` | Copy link |

## 12. Accessibility

- The comment mode change is announced: "Comment mode on. Click a Widget, or press Escape to cancel."
- The hover chip text is mirrored in a polite live region at most once per 500ms.
- A pin's accessible name reads like "Comment by Mei Lin on Button checkout-submit, ready for review, 3 messages".
- The bubble is `role="dialog"` with `aria-labelledby` on its title. Focus is trapped while it is open, and returns to the pin on close.
- Pin fill contrast against the canvas is 4.43 (light) and 7.70 (dark). Initials against the fill are 4.88 and 7.70. State is never color-only: badge icon plus accessible name.

## 13. Copy

| Key | en-US | zh-TW |
|---|---|---|
| comment.modeOn | Comment mode on. Click a Widget, or press Esc to cancel. | 已進入留言模式。點選 Widget，或按 Esc 取消。 |
| comment.hoverChip | Comment on {type} | 在 {type} 上留言 |
| comment.placeholder | Add a comment | 新增留言 |
| comment.send | Comment | 留言 |
| comment.scopeThis / scopeAll | This Variant / All Variants | 此 Variant／所有 Variant |
| comment.commentingAs | Commenting as {name} | 以 {name} 的身分留言 |
| comment.discard | Discard this comment? | 要捨棄這則留言嗎？ |
| thread.reply | Reply… | 回覆… |
| thread.resolve | Resolve | 標記為已解決 |
| thread.resolveHint | Accepts submission {id} | 接受提交 {id} |
| thread.reopen | Reopen | 重新開啟 |
| thread.submit | Submit for review… | 提交 Review… |
| thread.status.open / ready / resolved | Open / Ready for review / Resolved | 未解決／待審核／已解決 |
| thread.copyLink / reanchor / promote | Copy link / Re-anchor / Promote to Decision | 複製連結／重新錨定／升級為 Decision |
| pins.unplaced | {n} comments can't be placed | {n} 則留言無法定位 |
| pins.otherVariants | Other Variants · {n} | 其他 Variant・{n} |
| pins.notVisible | Not visible in this state | 在此狀態下不可見 |
| pins.variantMissing | Variant missing: {name} | 找不到 Variant：{name} |
| empty.title / body | No comments yet / Press C and click anything in the View to comment. | 還沒有留言／按 C，再點選 View 中的任何地方即可留言。 |
| allCaughtUp | All caught up · {n} resolved | 已全部處理・{n} 則已解決 |

## 14. Constraints and open decisions

- **Resolve semantics.** An `open` thread cannot be resolved directly; resolution must reference a `ready-for-review` submission (Part 7 #7). If designers expect "Resolve" on any comment, the lifecycle needs an architecture decision. Do not fake it in the UI.
- **Human "Submit for review".** This requires change domains plus evidence refs. Keep it secondary and desktop-first, and reuse the evidence picker from brief f.
- **Phase 2.** `displayHint.pin` (proposed in `adr-review-pin-hint.md`) slots into `resolvePinPoint` as `source: 'hint'`, captured from the iframe's final-target report. Until it is accepted, nothing about the click point is persisted.
- **Session memory scope.** Click offsets for threads created in this tab live in a reactive in-memory map and are cleared on reload. This is the honest Phase 1 behavior: a reloaded pin snaps to its default point.
- **Tracking N pinned Widgets at once.** Today's geometry correlation is navigation-scoped (`navigationRequestId`, one active target in `PreviewNavigationState`). Drawing pins for every visible thread needs either a batched acquisition message or a per-pin correlation field. That is a **Part 2 implementation-recovery decision** and must not be invented in code. Until it is decided, Phase 1 can show pins only for the selected or open thread plus list-only placement for the rest, or acquire them sequentially if the accepted correlation already allows it.
- **Pins during targeting.** Part 3 suspends Checks-highlight tracking during comment-range selection. Confirm that pins are a separate review-chrome consumer and stay tracked and visible while Comment mode is active (recommended reading).
- **Summary fields.** List summaries need `variantNames` and latest activity for Variant filtering and activity sort. Part 7 9b already requires both, so adding them aligns code with an accepted decision and is not new semantics.
- **Mobile comment creation** is undecided (default off).
- **Cursor inside the iframe:** see brief b.
