---
version: 1
slug: "app-pages-index-vue"
primary_target: "app/pages/index.vue"
related_targets: ["app/components/readiness/ReadinessTab.vue","app/components/readiness/OverviewChecks.vue","app/components/readiness/OverviewActivity.vue","app/components/readiness/EvidenceSheet.vue","app/components/readiness/CaptureSlideover.vue","app/components/readiness/HandoffExportModal.vue"]
---

# Shape brief (f): Overview and readiness (absorbing Checks, Evidence and Handoff)

Mode: **Operate**. Visual authority: `DESIGN.md` (blueprint register on the Evidence and Checks detail). Target: the new `/` Overview page and the View's Readiness tab. This replaces `ChecksPanel.vue`, `EvidencePanel.vue` and `HandoffPanel.vue` as top-level tabs; their logic moves into these surfaces.

## 1. Job and audience

- **Overview:** at the start of a session, a team member asks: *what changed, what is broken, what is waiting on us, and what can ship?* PMs use it to see progress. Developers use it to see what blocks Handoff.
- **Readiness (per View):** before calling a View done, a reviewer checks four things. It validates (Checks), its evidence is fresh (captures in the required contexts), its Reviews are closed, and its Handoff closure would be `implementation-ready`.

## 2. Outcome and proof

- Checks, Evidence and Handoff disappear as top-level tabs. They become four readiness facets shown per View, plus Workspace-wide summaries.
- The readiness facets map to accepted semantics:

| Facet | Source |
|---|---|
| Validation | Checks findings for the View: schema, runtime, translation reminders, `t` warnings (Part 5) |
| Evidence | Formal evidence records for explicit render contexts. Freshness compares the recorded resource revision with the current one (Part 1, Part 10) |
| Reviews | Unresolved threads anchored to the View (Part 7) |
| Handoff | The readiness gate evaluated with *this View as the root* and its deterministic dependency closure (Part 1, Handoff selected-scope and readiness-closure) |

- The generic Checks surface is preserved as **Overview › Checks**: findings only, grouped problem → View → Widget, with no Review queues (Part 5 boundary).
- Handoff export stays Workspace-scoped with explicit roots (Whole Workspace or selected Views and Flows). It is launched from Overview and from a View's Readiness tab, which pre-selects that View as the root.
- "What the agent changed" appears as *Updated since you last looked*. This is a per-browser last-seen revision per resource, with no schema change. True diffs are out of scope (no history model).

## 3. Selected direction

The Overview is a quiet dashboard: one Display-size line of what needs attention, then a dense Views table with readiness columns. There are no chart tiles or KPI card grids (that is the admin-template look). Readiness uses one row per facet with a status icon, a plain sentence, and one action. Detail opens in place, in the blueprint register: evidence thumbnails in a contact-sheet grid labelled with mono render contexts, and findings with mono codes.

## 4. Scope and boundaries

- **In scope:** the Overview page (attention summary, Views table, Checks tab, Activity tab), the per-View Readiness tab, the evidence capture flow (context picker, progress, results), and the Handoff export dialog (roots, assessment, export, result).
- **Untouched:** the Checks taxonomy, evidence record schema, Handoff manifest schema, and readiness gate semantics.
- **Anti-goals:**
  - KPI card grids;
  - charts without a decision behind them;
  - a hidden Cartesian product of capture contexts (Part 10: explicit lists only);
  - implying readiness on a bundle that is not `implementation-ready` (Part 1 export/readiness split).

## 5. Layout sketches

### Overview (desktop)

```
┌ Overview ─────────────────────────────────────────────────────────────────────────────────────┐
│ 2 waiting for review · 3 open · 4 Checks findings                       [Export handoff…]     │ Display-size first line
│ [ Views ] [ Checks 4 ] [ Activity ]                                                           │ UTabs
│───────────────────────────────────────────────────────────────────────────────────────────────│
│ View                     Feature    Variants  Reviews        Checks     Evidence    Readiness  │
│ ● Checkout               checkout   3         ◉2  ○1         ⚠ 2        ◷ stale     Blocked (3)│ ● = updated since last look
│   Workspace browser      workbench  1         —              ✓          ✓ fresh     ✓ Ready    │
│   Home                   marketing  2         ○1 ⚠anchor     ✕ 1        — none      Blocked (2)│
│ ⌕ Filter Views    Feature ▾   Readiness ▾                                     3 Views          │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
 Row click → /views/:id?panel=readiness
```

### Overview › Checks (generic Checks, findings only)

```
 Problem → View → Widget                                     Category ▾  Severity ▾
 ▾ ✕ schema.unknown_prop  Unknown property "tone" on Badge            1 View
     ▾ Home
         #promo-badge  Badge                                   Open ›
 ▾ ⚠ i18n.whitespace     Message is whitespace-only             zh-TW · 2 keys
     pay.cta · checkout.title                                   Open Locales ›
 ▾ ⚠ runtime.t_warning   Missing key "promo.title" in Preview  (live, current session)
```

### View › Readiness tab (right panel, 340px)

```
 Readiness · Checkout                          Blocked by 3
 ────────────────────────────────────────────────────────
 ✕  Validation      2 findings               View all ›
 ◷  Evidence        Stale: View changed after capture
                    [Capture again…]
 ◉  Reviews         2 ready for review, 1 open  Open ›
 ✕  Handoff         Not implementation-ready
                    Blocked by: open Reviews, stale evidence
                    [Export handoff…]
 ────────────────────────────────────────────────────────
 Evidence · 4 captures                       Capture… ▾
 ┌──────────┐┌──────────┐┌──────────┐┌──────────┐
 │ thumb    ││ thumb    ││ thumb    ││ thumb    │
 └──────────┘└──────────┘└──────────┘└──────────┘
  base       error-state  base        error-state
  desktop    desktop      desktop     desktop
  en-US·light en-US·light zh-TW·dark  zh-TW·dark      (mono 12px)
  ◷ stale    ◷ stale      ◷ stale     ◷ stale
 ▸ Details  (evidence digests, captured at, View revision)
```

### Capture dialog (desktop only, `USlideover`)

```
 Capture evidence · Checkout
 Contexts (explicit list)                 Select: All Variants · All locales · All viewports · All themes
 ☑ base         desktop  en-US  light
 ☑ error-state  desktop  en-US  light
 ☐ base         desktop  zh-TW  dark
 …                                            12 contexts selected
 [Cancel]                                     [Capture 12]
 → progress: UProgress per context, results stream in as thumbnails, failures listed with diagnostics
```

### Export handoff dialog (`UModal`, desktop and tablet)

```
 Export handoff
 Roots   (•) Whole Workspace   ( ) Selected:  [Checkout ×] [+ View or Flow]
 Assessment (closure: 3 Views, 1 Flow, 2 Assets, 2 locales)
   ✕ Not implementation-ready
     · Checkout: 2 Reviews unresolved
     · Checkout: evidence stale (4 contexts)
   You can still export a diagnostic snapshot. It won't claim readiness.
 [Cancel]                       [Export snapshot]
 → result: bundle id (mono, copy), path, readiness claim yes/no, "Open folder"/"Copy path"
```

## 6. Component choices

| Element | Component |
|---|---|
| Attention line | Text (Display role) with inline `ULink`s ("2 waiting for review" → `/reviews?status=ready-for-review`) |
| Tabs | `UTabs` |
| Views table | `UTable` (sortable headers, row click, sticky header). Cells use `UBadge` and `UIcon`. "Updated" marker: an 8px Iris dot with an `sr-only` "updated since you last looked". Mobile: `UCard` list |
| Checks tree | `UTree` (problem → View → Widget) per Part 5. Severity icon plus mono code. Selecting a Widget navigates (deferred if comment mode is active, per Part 3) |
| Activity | `UTimeline` of the latest Review timeline events across the Workspace, plus "updated since" resource rows. Read-only |
| Readiness rows | Custom rows (icon, title, sentence, `UButton` link-style action) |
| Evidence grid | `UCard` tiles with an image thumbnail (artifact URL), mono context caption, freshness `UBadge`, and a click to open the full capture in a `UModal` with zoom |
| Capture | `USlideover` holding a `UTable` with selection checkboxes, convenience `UButton`s that expand into the explicit list, and `UProgress` per run. Results via toast plus inline |
| Export | `UModal` with `URadioGroup` (roots), a `USelectMenu` multiple for selected roots, the assessment as a `UAlert` (success when ready, caution otherwise), and a result panel |

## 7. States

| State | Treatment |
|---|---|
| Empty Workspace (no Views) | Overview `UEmpty` (brief h): "No Views yet" / "Ask your agent to create one with `create_view`, then refresh." with "Copy MCP endpoint" and "Refresh" |
| All clear | Attention line: "Nothing waiting. 3 Views ready." in success tone (icon plus text) |
| Checks running | Row skeletons and a "Running Checks…" chip |
| Live `t` warnings without a Preview session | Category row: "Open a View to collect live Preview warnings." |
| Evidence none | "No evidence yet" plus "Capture…" (desktop). Tablet and mobile show the state without the action |
| Evidence stale | Caution: "View changed after capture." The stale reason names the changed resource (View revision, locale file, Asset) when determinable |
| Capture failed (per context) | Fault rows with the diagnostic, while the other contexts complete. Never all-or-nothing in the UI |
| Assessment unavailable (invalid closure) | Fault `UAlert` with diagnostics. Export is still allowed when a coherent snapshot is possible (Part 1), otherwise disabled with the reason |
| Export done | Success panel: "Snapshot exported" plus a mono bundle id. If ready: "implementation-ready" success badge. If not: a neutral "Diagnostic snapshot" badge. Never green |
| Publication mode | Readiness and evidence are read-only. Capture and Export are hidden |

## 8. Keyboard

| Keys | Action |
|---|---|
| `G O` | Overview |
| `1` / `2` / `3` | Views / Checks / Activity tab |
| `J` / `K` and `Enter` | Move through rows and open |
| `⇧⌘E` | Export handoff |
| `⇧⌘P` | Capture evidence for the current View (desktop) |

## 9. Accessibility

- Table headers are sortable buttons with `aria-sort`. Status cells use icon plus text (e.g. "Blocked, 3 reasons"), never color alone.
- Thumbnails have alt text built from the context: "Capture of Checkout, error-state, desktop 1280 by 800, zh-TW, dark".
- Capture progress is announced politely per completed context, at most one announcement per second.

## 10. Copy

| Key | en-US | zh-TW |
|---|---|---|
| overview.title | Overview | 總覽 |
| overview.attention | {ready} waiting for review · {open} open · {findings} Checks findings | {ready} 則待審核・{open} 則未解決・{findings} 個 Checks 問題 |
| overview.allClear | Nothing waiting. {n} Views ready. | 沒有待處理項目，{n} 個 View 已就緒。 |
| overview.tab.views / checks / activity | Views / Checks / Activity | Views／Checks／動態 |
| overview.updated | Updated since you last looked | 自你上次查看後已更新 |
| ready.validation / evidence / reviews / handoff | Validation / Evidence / Reviews / Handoff | 驗證／Evidence／Review／Handoff |
| ready.blockedBy | Blocked by {n} | 有 {n} 項阻擋 |
| ready.ready | Ready | 已就緒 |
| ready.notReady | Not implementation-ready | 尚未達到 implementation-ready |
| evidence.stale | Stale: View changed after capture | 已過時：擷取後 View 已變更 |
| evidence.capture | Capture… | 擷取… |
| evidence.captureN | Capture {n} | 擷取 {n} 項 |
| evidence.selectAll | All Variants · All locales · All viewports · All themes | 所有 Variant・所有 Locale・所有檢視區・所有主題 |
| handoff.export | Export handoff… | 匯出 Handoff… |
| handoff.roots.workspace / selected | Whole Workspace / Selected | 整個 Workspace／選取的項目 |
| handoff.diagnosticNote | You can still export a diagnostic snapshot. It won't claim readiness. | 仍可匯出診斷用快照，但不會標示為已就緒。 |
| handoff.exported | Snapshot exported | 已匯出快照 |
| handoff.diagnostic | Diagnostic snapshot | 診斷用快照 |

`implementation-ready` stays literal in both locales because it is a canonical claim value.

## 11. Constraints and open decisions

- **Per-View readiness** reuses the existing Handoff assessment with a single-View root. Confirm the HTTP assess endpoint accepts selected roots without exporting, because the current panel's "Re-Assess" suggests it does.
- **Evidence freshness** needs the evidence record's captured resource revisions compared with current revisions. If the record does not carry all of them (for example locale file revisions), freshness is reported as "unknown", never as fresh.
- **"Updated since you last looked"** is per browser and based on resource revisions. A server-side "changed at" timestamp or a change feed would be a new contract, so it needs a decision.
- **Activity feed** is limited to Review timeline events plus local "updated" markers. A real agent-change feed needs the ephemeral notification channel that Part 1 #12 allows in the future, which is unspecified today.
