---
version: 1
slug: "app-components-workbench-specdocument-vue"
primary_target: "app/components/workbench/SpecDocument.vue"
related_targets: ["app/components/workbench/WidgetInspector.vue","app/components/workbench/SpecSectionEditor.vue"]
---

# Shape brief (e): Inspector and Spec

Mode: **Operate** for the Inspector, **Read** for the Spec (especially on mobile). Visual authority: `DESIGN.md` (blueprint register: mono identities, hairlines, measured numbers). Target: the right panel's Inspect and Spec tabs, `app/components/workbench/SpecPanel.vue`, and the Inspector markup now in `index.vue`. The bottom Spec drawer is removed.

## 1. Job and audience

- **Inspector:** a reviewer clicks a Widget and wants to know what it is, where it sits, what this Variant changes about it, what is wrong with it, and what people have said about it. A developer wants the exact id and slot to tell their agent.
- **Spec:** a PM or designer reads the View's intent, entry conditions, interaction rules, constraints, accessibility notes, references and decisions to judge whether the View does what it claims. On mobile this is the main reading surface.

## 2. Outcome and proof

- The Inspector answers four questions in this order: *what* (type, label), *where* (slot path), *how this Variant differs* (override diff), and *what's wrong or discussed* (findings, threads). IDs, revisions and raw state are one click away in a "Details" disclosure. They are never the first thing seen (voice: precise instrument).
- The Spec reads as a structured document with a 68ch measure, 14px body text, mono section numbers, and hairline rules between sections. Decisions show status and provenance (their source Review thread).
- References and Decisions are no longer separate bottom tabs. They are sections of the Spec.
- Both live in the right panel (desktop), the slideover (tablet), and a tab (mobile). This follows The Same Place Rule.

## 3. Selected direction

Blueprint where facts are checked; plain language everywhere else.

- **Inspector:** a property sheet. 12px muted labels sit in a 96px left column, 13px values sit right, mono for identities and measurements, and hairlines separate the groups.
- **Spec:** a document. 15px titles with mono section markers (`§1 Intent`), 14px prose, and lists with comfortable spacing.

Inline references to Widgets, such as `#checkout-submit`, are mono links that select the Widget on the canvas.

## 4. Scope and boundaries

- **In scope:** Inspector content and states, Variant override diff, findings, the threads-on-this-Widget list, and the "Comment" and "Copy" affordances. Also the Spec sections, Decisions list with status and provenance, References list, Accessibility list, desktop editing affordances for Spec fields (through `update_view_spec`), and the mobile reading mode.
- **Out of scope:** structural editing of the Widget IR (agents through `update_view_structure`; any human structural editor is a separate task) and Catalog browsing.
- **Anti-goals:**
  - key/value cards boxed inside cards;
  - uppercase overlines everywhere;
  - mono for prose;
  - showing revision hashes in the default view;
  - Spec editing on mobile.

## 5. Layout sketches

### Inspect tab (desktop right panel, 340px)

```
 Inspect                                                    ⋯
 ───────────────────────────────────────────────────────────
 ▢ Button                                   [◖ Comment] [⧉]
   "Pay now"                                     (copy id)
 ───────────────────────────────────────────────────────────
 Identity    #checkout-submit                    (mono)
 Slot        root › form › actions › content[0]  (mono, each segment selects)
 Size        320 × 44  at  480, 612              (mono, live geometry)
 ───────────────────────────────────────────────────────────
 In this Variant  error-state
   Property     Base            error-state
   disabled     false           true          (changed row tinted Iris/10)
   label        "Pay now"       "Retry payment"
   No other overrides.
 ───────────────────────────────────────────────────────────
 Findings · 1
   ⚠ i18n.whitespace   Message "pay.cta" is whitespace in zh-TW   ›
 ───────────────────────────────────────────────────────────
 Comments on this Widget · 2
   ◉ (ML) Pay label copy                      2h   ›
   ○ (JS) Disabled state contrast             1d   ›
 ───────────────────────────────────────────────────────────
 ▸ Details   (type id, plugin, Catalog entry, View revision, raw state JSON)
```

### Spec tab (desktop) / mobile Spec tab

```
 Spec · Checkout                                   Edit ✎ (desktop only)
 ───────────────────────────────────────────────────────────
 §1  Intent
     Let a shopper fix a failed payment without re-entering
     their card details.
 ─────
 §2  Entry conditions · 2
     · Arrives from the payment step after a decline.
     · Cart total is unchanged.
 ─────
 §3  Interaction rules · 4
     · Retry keeps the entered address. Selecting #retry-button …
 ─────
 §4  Constraints · 1
 §5  Accessibility · 3
     · Error message is announced politely (aria-live).
 ─────
 §6  Decisions · 2
     ◷ Pending   Show saved cards first?              from Review ›
     ✓ Decided   Keep top nav out of RootShell        Oct 1
         Outcome: Keep RootShell minimal …
 ─────
 §7  References · 2
     ↗ Figma · Checkout v3        design
     ↗ PRD-142                    requirement
```

## 6. Component choices

| Element | Component |
|---|---|
| Panel tabs | `UTabs` (variant `link`, size `sm`) with the items Comments · Inspect · Spec · Readiness. The selected tab is persisted in the URL `panel=` |
| Widget header | Type icon (`UIcon`), title 15px, label excerpt, `UButton` "Comment" (annotation, soft), `UButton` ghost icon "Copy id" with a toast "Copied #checkout-submit" |
| Property rows | Semantic `<dl>` grid (no Nuxt UI component fits a definition list; keep custom and document why) |
| Slot path | `UBreadcrumb` (mono, each item a button that selects that ancestor) |
| Override diff | `UTable` (compact), three columns, changed cells marked with the Iris tint plus a `sr-only` "changed" |
| Findings | `UAlert`-free list rows: severity icon plus code (mono) plus message, linking to Readiness › Checks for the full finding |
| Threads | Compact rows, the same anatomy as the Reviews list |
| Details | `UCollapsible`, containing mono values with copy buttons and a raw-state code block (`<pre>` in `UScrollArea`) |
| Spec sections | `UAccordion` (multiple, all open by default on desktop; on mobile §1 is open and the rest collapsed) |
| Decision status | `UBadge` subtle: pending = warning plus `i-lucide-clock`, decided = success plus `i-lucide-check`, deferred = neutral plus `i-lucide-pause` |
| Spec editing (desktop) | "Edit" switches a section into a form (`UForm`, `UFormField`, `UTextarea`, `UInputTags` for lists) with Save and Cancel. It saves through `update_view_spec` with `expectedRevision`, one section at a time |
| References | `ULink` with an external icon, plus a type `UBadge` |

## 7. States

| State | Inspector | Spec |
|---|---|---|
| Nothing selected | `UEmpty` (compact): "Select a Widget" / "Click a Widget in the View or the Layers list." | n/a |
| Selected Widget hidden in this state | Header plus "Not visible in this state". No size row | n/a |
| Selected Widget missing (deep link) | Persistent caution `UAlert`: "Widget #x isn't in this View anymore." with a "Select its parent" suggestion when the hint exists | n/a |
| Variant invalid | Diff section replaced by a fault `UAlert` listing the Variant diagnostics | Unaffected |
| Empty Spec section | n/a | Dashed placeholder row: "No interaction rules yet." On desktop, "Add" (opens edit) |
| Saving | n/a | Save button loading. Fields read-only |
| Revision conflict | n/a | Caution `UAlert`: "The Spec changed since you started editing." with "Review their version" (side-by-side text) and "Discard mine". Never auto-merge |
| Publication mode | Read-only. Comment hidden | Edit hidden |

## 8. Keyboard

| Keys | Action |
|---|---|
| `]` | Toggle right panel |
| `⌥1` – `⌥4` | Comments / Inspect / Spec / Readiness tab |
| `Alt ↑` / `Alt ↓` | Parent / child Widget (shared with canvas) |
| `⌘C` with the Inspector focused and nothing selected in text | Copy Widget id |
| `E` in the Spec | Edit the focused section (desktop) |
| `⌘↵` / `Esc` | Save / cancel the section |

## 9. Accessibility

- Property sheet: `<dl>` with `<dt>` / `<dd>`. Mono values carry `translate="no"` so browser translation does not mangle ids.
- The diff table has a caption, "Properties changed by Variant error-state". Changed state is conveyed in text, not only by tint.
- Spec headings are real `h3`, with the section marker hidden from AT (`aria-hidden` on `§1`). Lists are real lists. The prose measure is at most 68ch.
- In zh-TW the Spec renders authored text as-is (Workspace content is not translated). Only labels are translated, with `lang` on authored content set from the Workspace primary locale when known.

## 10. Copy

| Key | en-US | zh-TW |
|---|---|---|
| panel.comments / inspect / spec / readiness | Comments / Inspect / Spec / Readiness | 留言／屬性／Spec／就緒狀態 |
| inspect.empty.title / body | Select a Widget / Click a Widget in the View or the Layers list. | 選取 Widget／在 View 或圖層清單中點選 Widget。 |
| inspect.identity / slot / size | Identity / Slot / Size | 識別碼／Slot／尺寸 |
| inspect.inVariant | In this Variant | 在此 Variant 中 |
| inspect.base | Base | 基本 |
| inspect.noOverrides | No overrides in this Variant. | 此 Variant 沒有覆寫。 |
| inspect.findings | Findings | 問題 |
| inspect.commentsHere | Comments on this Widget | 此 Widget 的留言 |
| inspect.details | Details | 詳細資料 |
| inspect.copied | Copied {id} | 已複製 {id} |
| spec.intent / entry / rules / constraints / a11y / decisions / refs | Intent / Entry conditions / Interaction rules / Constraints / Accessibility / Decisions / References | 意圖／進入條件／互動規則／限制／無障礙／Decision／參考資料 |
| spec.emptySection | No {section} yet. | 尚無{section}。 |
| spec.fromReview | from Review | 來自 Review |
| spec.conflict | The Spec changed since you started editing. | 你開始編輯後，Spec 已有變更。 |

## 11. Constraints and open decisions

- Human structural editing (adding or moving Widgets) is not in this brief. If wanted, it needs its own shape plus Catalog UX, and stays desktop-only.
- "Size" uses live runtime geometry from the iframe and is display-only. It is never persisted.
