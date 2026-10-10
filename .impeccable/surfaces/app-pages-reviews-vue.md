---
version: 1
slug: "app-pages-reviews-vue"
primary_target: "app/pages/reviews.vue"
related_targets: ["app/components/workbench/ReviewInboxFilters.vue","app/components/workbench/ReviewInboxList.vue","app/components/workbench/ReviewThreadDetail.vue","app/components/workbench/ReviewTimeline.vue","app/composables/useReviewInbox.ts","app/utils/review-inbox.ts","app/utils/review-timeline.ts"]
---

# Shape brief (d): Reviews inbox

Mode: **Operate**. Visual authority: `DESIGN.md`. Target: the new `/reviews` page (`app/pages/reviews.vue`) and `ReviewInboxList.vue`, `ReviewThreadDetail.vue`, `ReviewTimeline.vue`. It absorbed the list and conversation parts of the former `ReviewsPanel.vue`, which R8 removed.

## 1. Job and audience

Each morning, or after an agent run, a reviewer asks: *what is waiting for me?* Agents have submitted fixes that need a human verdict, and colleagues have opened comments. The inbox is the team's queue. It must put "needs your verdict" first, show who said what, and take the reviewer to the exact canvas context in one click. On mobile this is the home screen and the main triage surface.

## 2. Outcome and proof

The inbox implements Part 7 decisions 10a and 10b exactly:

- the default queue **hides resolved**, groups **`ready-for-review` before `open`**, and sorts each group by **latest canonical timeline activity, descending**;
- resolved threads are reachable by an explicit filter;
- structured filters cover at least status, View, Widget/anchor validity, Variant scope and change/evidence domain, and finding work never depends on free-text search alone;
- thread detail renders **one chronological timeline** projecting `messages[]`, `submissions[]` and `history[]` (re-anchor and lifecycle events) by authoritative timestamp. Typed items keep their payloads, submissions expand their evidence refs, and a resolution names the accepted submission.

Author identity is visible on every row and timeline item: human initials, an agent glyph, or a system glyph, plus display name. Multiple reviewers are told apart without colored avatars (The One Colorful Thing Rule).

## 3. Selected direction

A Linear-style master–detail layout:

- **List:** dense, keyboard-first rows, with a group header per status.
- **Detail:** a reading column, so the timeline reads like a PR conversation (the GitHub PR register for lifecycle events). It also carries an "Open in canvas" action that drops the reviewer into the View with the bubble open.

## 4. Scope and boundaries

- **In scope:** the inbox list, filters and saved filters, detail timeline, inline lifecycle actions (reply, resolve, reopen, promote to Decision, re-anchor entry), author identity display, the reviewer identity picker, deep links, and empty, loading and error states.
- **Out of scope:** canvas pins (brief c) and the evidence capture UI (brief f).
- **Untouched:** Review schema, MCP query shapes, and append-only semantics. There is no edit or delete of messages, and no hard delete of threads (Part 7 #2, #8).
- **Anti-goals:**
  - a flat chat log that flattens events into message text;
  - a fourth "archived" state;
  - color-coded reviewers;
  - unread or "mine" semantics that need a persisted identity model.

## 5. Layout sketches

### Desktop (1920)

```
┌ sidebar ┬ Reviews ─────────────────────────── 420px ┬ thread ──────────────────────────────────────────┐
│ ◫ Over. │ ⌕ Search threads          ⚲ Filters (2) ▾ │ Pay label copy                     Open in canvas ↗│
│ ▢ Views │ [Status: Ready, Open ×] [View: Checkout ×] │ ◉ Ready for review · Checkout › error-state       │
│ ⌥ Flows │ Sort: Latest activity ▾          Clear all │ Button · #checkout-submit · scope: error-state     │
│ ▤ Revie…│───────────────────────────────────────────│───────────────────────────────────────────────────│
│ ─────── │ ▾ READY FOR REVIEW · 2                    │ (ML) Mei Lin                       Oct 5, 09:12  │
│ Saved   │ ▌◉ (AI) Totals row misaligned      14m  3 │ Label should say "Pay NT$1,280".                  │
│ · Mine  │    Checkout · #totals · i18n IR           │                                                   │
│ · zh-TW │  ◉ (ML) Pay label copy             2h   2 │ (AI) Claude · agent                Oct 5, 11:40  │
│         │    Checkout › error-state · #submit       │ Updated the label binding to the price token.     │
│         │ ▾ OPEN · 3                                │                                                   │
│         │  ○ (JS) Error text too long        1d   4 │ ┊ ⇪ Submitted for review          Oct 5, 11:41  │
│         │    Checkout · #error-banner · zh-TW        │ ┊   Changes: i18n · IR   Evidence: 2 ▸           │
│         │  ○ (ML) Promo banner removed?  ⚠   3d   1 │ ┊   capture  sha256:9b1f…c03e  desktop·zh-TW·dark │
│         │    Home · #promo-banner (missing)          │ ┊   validation sha256:41aa…77d2  passed           │
│         │                                           │───────────────────────────────────────────────────│
│         │                                           │ ┌ Reply… ───────────────────────────────────────┐ │
│         │                                           │ └───────────────────────────────────────────────┘ │
│         │                                           │ Promote to Decision ▾   Reopen   [✓ Resolve]      │
└─────────┴───────────────────────────────────────────┴───────────────────────────────────────────────────┘
```

Each row has the following parts:

- a status icon;
- the author avatar (initials or agent glyph);
- the title, which is the first message excerpt (one line);
- relative time (`fmt.relative`, full time in a tooltip);
- the message count;
- a second line: View › Variant scope · Widget (mono id) · change domains (mono chips, ready rows only);
- a warning glyph for an invalid or stale anchor.

### Tablet (1024)

The list takes the full width. Selecting a row opens the detail in a `USlideover` (right, 560px), and "Open in canvas" closes it and navigates.

### Mobile (390)

```
┌──────────────────────────────┐
│ ☰  Reviews            ⚲ (ML) │
├──────────────────────────────┤
│ [Ready 2][Open 3][Resolved]  │ UTabs as status filter (resolved explicit)
│ ◉ (AI) Totals row misaligned │
│   Checkout · #totals   14m 3 │
│ ◉ (ML) Pay label copy        │
│   Checkout · #submit    2h 2 │
├──────────────────────────────┤
│  ◫     ▢     ⌥     ▤ 5       │
└──────────────────────────────┘
 Row tap → full-screen detail page (/reviews?thread=…) with back; reply bar pinned
 above the keyboard; Resolve / Reopen in a sticky action row; "Open in canvas" → View tab.
```

## 6. Component choices

| Element | Component |
|---|---|
| Page | Two `UDashboardPanel`s (list `resizable`, default 420px) with a `UDashboardNavbar` title "Reviews" |
| Search | `UInput` with leading icon, debounced, searching message text and Widget ids |
| Filters | `UPopover` holding `UFormField`s: Status (`UCheckboxGroup`), View (`USelectMenu` multiple, searchable), Anchor (`URadioGroup`: Any / Valid / Stale / Missing), Variant scope (`USelectMenu`: Any / View-wide / specific Variants), Change domain (`USelectMenu` multiple: IR, Variant, Spec, i18n, Adapter/config, Flow), Author (`USelectMenu` from actors present). Active filters render as removable `UBadge` chips |
| Saved filters | Sidebar context section listing presets (per browser, `localStorage`): "Ready for review", "Needs re-anchor", "zh-TW", plus "Save current filter" |
| List | Virtualized list (custom rows on `UScrollArea`). Group headers are `UCollapsible` |
| Avatar | `UAvatar` (size `sm`, neutral, initials from displayName). Agent: `UAvatar` with `i-lucide-bot`. System: `i-lucide-cog` |
| Timeline | `UTimeline` (vertical) with custom item slots per type: message, submission, re-anchor, lifecycle |
| Evidence refs | `UCollapsible` rows: kind badge plus mono digest (middle-truncated, copy button) plus context summary when the evidence record is readable. "Open evidence" opens the View's Readiness tab |
| Reply | `UTextarea` (autoresize) plus `UButton` "Reply" (`⌘↵`) |
| Lifecycle actions | Resolve: `UButton` primary, enabled only on `ready-for-review`; its tooltip names the submission. Reopen: `UButton` neutral, opens an inline reason `UTextarea` (optional reason per Part 7 #7). Promote: `UDropdownMenu` → `UModal` with the Decision form (title, outcome, status `pending` / `decided` / `deferred`) |
| Re-anchor | `UButton` "Re-anchor…". Navigates to the canvas in re-anchor targeting mode (brief c) and returns |
| Identity picker | Navbar `UDropdownMenu`: current name, recent names, names from Review actors, and "Add name" (`UInput`) |

## 7. Ordering and filtering rules (normative from Part 7 10a)

1. Default filter: status ∈ {ready-for-review, open}.
2. Group order: ready-for-review, then open (then resolved, when included).
3. Within a group: latest canonical timeline activity descending. This is the max timestamp across messages, submissions and history, not the file modified time.
4. Search narrows within the filtered set and never changes the ordering.
5. URL reflects filters (`/reviews?status=ready-for-review,open&view=<id>`), so a filtered inbox is shareable.

## 8. Timeline item anatomy (Part 7 10b)

| Type | Rendering |
|---|---|
| Message | Avatar, name, actor-type tag for agents ("agent"), time, and body (14px, preserved line breaks, no Markdown rendering unless decided later) |
| Submission | Icon `i-lucide-git-pull-request-arrow`, "Submitted for review", the actor, change-domain chips, an evidence count with expansion, and a mono submission id one click away. The current submission is marked "Current" |
| Re-anchor | Icon `i-lucide-crosshair`: "Re-anchored from `#old` to `#new`", plus scope change and optional reason |
| Lifecycle | Resolved: icon `i-lucide-circle-check`, success color, "Resolved by Mei Lin · accepted submission 3f2a…". Reopened: icon `i-lucide-rotate-ccw`, "Reopened by …", plus the reason |

The timeline is a projection only; nothing is written back as message text.

## 9. States

| State | Treatment |
|---|---|
| Loading | Six row skeletons and a detail skeleton |
| Empty (no threads in Workspace) | `UEmpty`: "No Reviews yet". Body: "Comments made on a View's canvas show up here." Action: "Go to Views" |
| Empty (filtered) | "No threads match these filters." with "Clear filters" |
| All caught up | "Nothing waiting for review" plus a count of resolved, with "Show resolved" |
| Anchor invalid | Row ⚠ plus "(missing)". Detail header `UAlert` (caution): "This Widget no longer exists in the View." with Re-anchor, and the last-known hint |
| Thread file invalid | Row in fault style: "Can't read this thread", with the diagnostics in the detail. Never hidden silently |
| Revision conflict on action | Inline caution above the reply: "This thread changed since you opened it." Timeline refreshed, draft kept |

## 10. Keyboard

| Keys | Action |
|---|---|
| `J` / `K` | Next / previous row |
| `Enter` | Open detail |
| `O` | Open in canvas |
| `R` | Reply |
| `⌘↵` | Send |
| `⇧⌘↵` | Resolve |
| `⇧⌘O` | Reopen |
| `F` | Focus filters |
| `/` | Focus search |
| `1` / `2` / `3` | Toggle Ready / Open / Resolved filter |
| `Esc` | Close detail (tablet and mobile) or clear search |

## 11. Accessibility

- The list is a `listbox`-like grid with `aria-activedescendant`, and each group is labelled ("Ready for review, 2 threads").
- Each row's accessible name joins status, author, title, View, Widget and time. The relative time has an absolute `title` and `datetime`.
- The timeline is an ordered list. Event items carry their type in text ("Submitted for review"), not just an icon.
- Disabled Resolve on an `open` thread explains why in a tooltip and through `aria-describedby`: "Resolve becomes available after a fix is submitted for review."

## 12. Copy

| Key | en-US | zh-TW |
|---|---|---|
| inbox.title | Reviews | Reviews |
| inbox.group.ready / open / resolved | Ready for review / Open / Resolved | 待審核／未解決／已解決 |
| inbox.search | Search threads | 搜尋討論串 |
| inbox.filters | Filters | 篩選 |
| inbox.filter.anchor | Anchor | 錨點 |
| inbox.filter.anchorValid / stale / missing | Valid / Stale / Missing | 有效／過時／遺失 |
| inbox.filter.scope | Variant scope | Variant 範圍 |
| inbox.filter.viewWide | View-wide | 整個 View |
| inbox.filter.domain | Change domain | 變更範圍 |
| inbox.filter.author | Author | 作者 |
| inbox.openInCanvas | Open in canvas | 在畫布中開啟 |
| inbox.empty.title / body | No Reviews yet / Comments made on a View's canvas show up here. | 還沒有 Review／在 View 畫布上留下的留言會顯示在這裡。 |
| inbox.noMatch | No threads match these filters. | 沒有符合篩選條件的討論串。 |
| inbox.caughtUp | Nothing waiting for review | 沒有待審核的項目 |
| timeline.submitted | Submitted for review | 已提交 Review |
| timeline.current | Current | 目前 |
| timeline.reanchored | Re-anchored from {from} to {to} | 已從 {from} 重新錨定至 {to} |
| timeline.resolvedBy | Resolved by {name} · accepted submission {id} | 由 {name} 解決・已接受提交 {id} |
| timeline.reopenedBy | Reopened by {name} | 由 {name} 重新開啟 |
| timeline.agent | agent | agent |
| action.resolveDisabled | Resolve becomes available after a fix is submitted for review. | 修正提交 Review 後即可標記為已解決。 |
| action.promote | Promote to Decision | 升級為 Decision |
| decision.pending / decided / deferred | Pending / Decided / Deferred | 待定／已決定／延後 |
| conflict.thread | This thread changed since you opened it. | 開啟後這個討論串已有變更。 |

## 13. Constraints and open decisions

- **"Mine", "mentions" and "unread"** need a persisted reviewer identity or per-user state. Neither exists (no auth, no roster). Saved filters and last-seen markers are per browser only.
- **Author filter** options are derived from actors found in loaded summaries. The MCP query shape filters by status, View, anchor validity, Variant scope and domain (Part 7 9b), but not by author. Author filtering is therefore client-side over loaded pages. A server-side author filter would extend the query contract and needs a decision.
- **Activity sort** needs a "latest canonical timeline activity" value in list summaries. Part 7 9b includes it, so confirm the HTTP summary exposes it before building.
- **Markdown in messages** is undecided. Render plain text with linkified URLs only.
