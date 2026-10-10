---
id: 01a11a5d-fd6b-7f9d-be15-2bc2bc3adc13
title: Single-resource restore
summary: "Bringing one design resource back to its content in an earlier version
  as a new forward write: its checks, schema handling, what a View restore
  keeps, impact acknowledgement, its effects on Evidence, Handoff readiness and
  Reviews, and the Workbench action."
rules:
  - id: 01a11a5e-1428-70eb-9d75-b54ba25015cb
    statement: A restore writes one design resource's content from a chosen version
      as a new current revision; it never rewrites or removes history.
  - id: 01a11a5e-147c-79e2-82d6-85df8b6f0e34
    statement: A restore changes exactly one resource; there is no whole-version revert.
  - id: 01a11a5e-14ce-7894-9c46-a8ad4b45e6d6
    statement: A restore is recorded in history like any design write, attributed to
      the member who restored and naming the version it restored from.
  - id: 01a11a5e-1520-78ac-a711-6e51c54c2079
    statement: "A restore is a write of its target resource: edit leases and
      revision checks apply exactly as to an authoring write, against the
      target's current revision, not the restored version's."
  - id: 01a11a5e-1580-7908-9f77-98667dc2e96f
    statement: Restored content is upgraded in memory to the current schema and
      validated exactly like an authoring write; invalid content is refused with
      diagnostics and nothing is written.
  - id: 01a11a5e-15e9-797f-9a1c-1e6ea5b7c431
    statement: Restoring Workspace settings keeps the current manifest `schemaVersion`.
  - id: 01a11a5e-1645-7f02-ae9e-05dd242e4a82
    statement: Restoring a View replaces its name, `feature` tag, IR, Variants and
      non-Decision Spec sections, and keeps its current Decisions.
  - id: 01a11a5e-16a2-7c0b-9495-3dae49e9dda3
    statement: Restoring a resource that no longer exists re-creates it with its
      original identity.
  - id: 01a11a5e-16f7-7229-8d17-587490168f1f
    statement: Before writing, a restore reports its impact; with a non-empty impact
      list it writes only when the caller acknowledges the impact, and otherwise
      writes nothing.
  - id: 01a11a5e-174b-7e74-b232-5ec76601fbed
    statement: A restore's impact list names Review threads whose Widget anchor
      would become invalid or valid again, `$i18n` and `$asset` references that
      would dangle, UX Flow steps whose Widgets would disappear, and
      ready-for-review submissions whose named revision would stop or start
      being current.
  - id: 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9
    statement: Restoring Workspace settings also lists removed or renamed viewport
      and theme keys with the threads whose render context names them, for
      information, and the formal Evidence that would become stale, including
      through a changed `adapters` selection, order or configuration.
  - id: 01a11a5e-17f7-7bdf-8cec-24fea8c348b2
    statement: "A restore gives Evidence no special treatment: Evidence captured at
      the restored revision is fresh again only if every freshness Rule holds,
      Adapter provenance included."
  - id: 01a11a5e-184c-7184-bb0b-781744e6a1ca
    statement: A restore changes no Review submission or resolution; Handoff
      readiness is recomputed as after any write.
  - id: 01a11a5e-189f-7b86-8270-e9b5d62aaa65
    statement: Review threads are never restored.
  - id: 01a11a5e-18f2-7991-8f7d-aa4c8015d14a
    statement: The Workbench restores from a resource's diff with "Restore this
      version", showing the impact list and asking for explicit confirmation
      before writing.
  - id: 01a11c09-c648-71be-a550-2ecabf12f5d0
    statement: A restore also needs the write key of the restored resource's kind as
      the Access Contract assigns it, so `history.restore` never stands in for a
      missing write key.
  - id: 01a11e0d-d911-7030-9565-7473aa0995e1
    statement: The autosave holding a restore's write event closes right after it,
      so every restore forms a version of its own.
---

## Sources

- Discussion #122 body (2026-10-06, accepted as written on 2026-10-08), "UIUX Architecture Decisions — Part 11: Workspace Version Timeline": decisions 1-13, Proposed defaults R1-R34, Amended decisions and "What `.spec/` records after acceptance". https://github.com/DevilTea/uiux/discussions/122
- Discussion #122 comment (2026-10-08), "Owner acceptance — 2026-10-08": decisions 1-13 and every Proposed default R1-R34 accepted as stated; R33 (timeline in Overview › Activity, View-page `history` panel, selections in the address) and R34 (Restore on desktop only) confirmed. https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263
- Owner pre-answers O1-O7 (2026-10-06), folded into the Discussion #122 body: O1 hybrid storage, O2 single-resource restore, O3 Reviewer+ checkpoints, O4 fixed grouping and retention, O5 no history in the publication, O6 no Git `HEAD`, O7 no automatic checkpoint at task end. https://github.com/DevilTea/uiux/discussions/122
- Discussion #140 body (Part 15, 2026-10-08), "Proposal — Permission keys and role presets: explicit key sets per member, Workspace-defined presets and derived labels": decisions 1–13, owner answers Q1–Q12, Amended decisions, "What `.spec/` records after acceptance" and Proposed defaults R1–R30. https://github.com/DevilTea/uiux/discussions/140
- Discussion #140 comment (2026-10-08), "Owner acceptance — 2026-10-08": accepted as written, every decision and Proposed default included. https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365
- Discussion #140 comment (2026-10-08), "Owner rulings — 2026-10-08 (clarifications to the accepted proposal)": ruling 1, applying a preset to an Agent drops its `humanOnly` keys; ruling 2, Product Kit Tools that ship before permission keys authorize by the upgrade mapping's keys. https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18819026
- Discussion #122 comment (2026-10-09), "Owner rulings — 2026-10-09 (implementation clarifications, #132, continued)": rulings 1-8 on the address keys, a restore as its own version, `expectedRevision: null` for a missing resource, the standalone impact analyzer, Adapter-based Evidence staleness, stage-only synchronized scrolling, Checkpoint deletion in the Workbench and the separate Review event list. https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439

## Rule sources

| Rule | Sources |
| --- | --- |
| 01a11a5e-1428-70eb-9d75-b54ba25015cb | [#122 body: decision 10, A](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R17](https://github.com/DevilTea/uiux/discussions/122); owner pre-answer O2 (2026-10-06, [#122 body: Owner answers of 2026-10-06](https://github.com/DevilTea/uiux/discussions/122)); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L113`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L113) restore service; [code@6ee4a5c `src/application/services/history-restore.ts#L245`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L245) a new revision through the authoring repositories |
| 01a11a5e-147c-79e2-82d6-85df8b6f0e34 | [#122 body: decision 10, A, B deferred](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R17](https://github.com/DevilTea/uiux/discussions/122); owner pre-answer O2 (2026-10-06, [#122 body: Owner answers of 2026-10-06](https://github.com/DevilTea/uiux/discussions/122)); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L113`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L113) one `{ kind, key }` per restore |
| 01a11a5e-14ce-7894-9c46-a8ad4b45e6d6 | [#122 body: decision 10, A: `restoredFrom`](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/access/scoped-session.ts#L409`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/access/scoped-session.ts#L409) member actor and `restoredFrom` in the design-write context |
| 01a11a5e-1520-78ac-a711-6e51c54c2079 | [#122 body: decision 10, rules 1, 2](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R18](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/access/scoped-session.ts#L409`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/access/scoped-session.ts#L409) target lease; [code@6ee4a5c `src/application/services/history-restore.ts#L144`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L144) revision check against the current revision |
| 01a11a5e-1580-7908-9f77-98667dc2e96f | [#122 body: decision 10, rule 3](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L206`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L206) in-memory upgrade; [code@6ee4a5c `src/application/services/history-restore.ts#L406`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L406) authoring validation |
| 01a11a5e-15e9-797f-9a1c-1e6ea5b7c431 | [#122 body: decision 10, rule 3](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R32](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L392`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L392) keeps `schemaVersion` |
| 01a11a5e-1645-7f02-ae9e-05dd242e4a82 | [#122 body: decision 10, rule 4](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R16](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L392`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L392) keeps the current Decisions; [#122 owner rulings 2026-10-09 (#132, restore): ruling 1, a restore that re-creates a View that no longer exists keeps the Decisions recorded in the version; an existing View keeps its current Decisions](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18837266) |
| 01a11a5e-16a2-7c0b-9495-3dae49e9dda3 | [#122 body: decision 10, rule 8](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L252`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L252) `expectedRevision: null` re-creates |
| 01a11a5e-16f7-7229-8d17-587490168f1f | [#122 body: decision 10, rule 5](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L158`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L158) impact before writing; [code@6ee4a5c `src/domain/impact/analyzer.ts#L62`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/domain/impact/analyzer.ts#L62) standalone analyzer; implementation reading ([PR #161](https://github.com/DevilTea/uiux/pull/161), issue #132 B6): every listed impact needs `acknowledgeImpact`, the informational viewport and theme keys of 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9 included, because this Rule gates the write on any "non-empty impact list", 17a0 adds those keys to the list ("also lists"), and 01a1144e-50dd-7b92-aa5e-e175e34bf424 already requires acknowledgement before a viewport or theme key is renamed; implementation reading (same PR): the HTTP route answers 409 for `impact_acknowledgement_required`, an implementation choice, since there is no HTTP Contract (standing owner ruling) and Clause 01a11a5e-2768-76ad-b02a-e15f50f91268 owns only the refusal itself |
| 01a11a5e-174b-7e74-b232-5ec76601fbed | [#122 body: decision 10, rule 5](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/domain/impact/analyzer.ts#L62`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/domain/impact/analyzer.ts#L62) anchors, `$i18n`/`$asset`, Flow steps, submissions; implementation reading ([PR #161](https://github.com/DevilTea/uiux/pull/161), issue #132 B6): anchors are checked for every Review thread, resolved ones included, because this Rule names "Review threads whose Widget anchor would become invalid or valid again" with no status condition; implementation reading (same PR): a `$i18n` reference dangles when the default Locale lacks its key, because another Locale lacking it falls back to the default Locale's text (01a115cd-b732-79db-b872-ac27713f15f8) and only a key missing from both resolves to the unresolved-key marker (01a115cd-b763-7fd6-b1df-0b7b568c1879) |
| 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9 | [#122 body: decision 10, rule 5](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Interactions 1](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Interactions 2](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); "configuration" aligned with the Evidence freshness Rule 01a115cd-c6de-7744-be27-715bec2e7fef as amended by Part 12 ([#130 acceptance](https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264)); [code@6ee4a5c `src/domain/impact/analyzer.ts#L266`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/domain/impact/analyzer.ts#L266) removed viewport and theme keys; [code@6ee4a5c `src/domain/impact/analyzer.ts#L285`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/domain/impact/analyzer.ts#L285) formal Evidence made stale; implementation reading ([PR #161](https://github.com/DevilTea/uiux/pull/161), issue #132 B6): formal Evidence is listed only for a settings restore, because this Rule's scope is "Restoring Workspace settings also lists … the formal Evidence that would become stale", and 01a11a5e-174b-7e74-b232-5ec76601fbed, which covers every restore, names no Evidence |
| 01a11a5e-17f7-7bdf-8cec-24fea8c348b2 | [#122 body: decision 10, rule 6](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Interactions 2](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L245`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L245) no Evidence is touched; freshness is computed on read |
| 01a11a5e-184c-7184-bb0b-781744e6a1ca | [#122 body: decision 10, rule 7](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L245`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L245) writes the target only |
| 01a11a5e-189f-7b86-8270-e9b5d62aaa65 | [#122 body: decision 10, rule 9](https://github.com/DevilTea/uiux/discussions/122); [#122 body: decision 2](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@6ee4a5c `src/application/services/history-restore.ts#L338`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/services/history-restore.ts#L338) Reviews are not a restorable kind |
| 01a11a5e-18f2-7991-8f7d-aa4c8015d14a | [#122 body: decision 11, Workbench: Restore](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R34](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); [code@479c0e4 `app/components/history/RestoreVersionAction.vue#L120`](https://github.com/DevilTea/uiux/blob/479c0e491c102dd90d2f561df39d331a0018382b/app/components/history/RestoreVersionAction.vue#L120) the action on a resource's diff: the explicit confirmation, the impact list and the resend with `acknowledgeImpact`; [code@479c0e4 `app/utils/version-restore.ts#L43`](https://github.com/DevilTea/uiux/blob/479c0e491c102dd90d2f561df39d331a0018382b/app/utils/version-restore.ts#L43) the selected version is the one restored; implementation reading (issue #132 B10): "this version" is the comparison's selected version, whichever side it is, so it must hold the resource |
| 01a11c09-c648-71be-a550-2ecabf12f5d0 | [#140 body: Interactions 2](https://github.com/DevilTea/uiux/discussions/140); [#140 body: R7](https://github.com/DevilTea/uiux/discussions/140); [#140 acceptance](https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365); PR #145 review (https://github.com/DevilTea/uiux/pull/145): it names the Access Contract's write key per kind (01a11c09-a42a-7d6b-bb5e-01d7cf1ce2de) and is the single owner of the restore's second key; [code@6ee4a5c `src/application/access/scoped-session.ts#L409`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/access/scoped-session.ts#L409) the kind's write operation is authorized too |
| 01a11e0d-d911-7030-9565-7473aa0995e1 | [#122 owner rulings 2026-10-09 (continued): ruling 2, the open autosave is closed before the restore event and again after it, so the restore stands alone with `restoredFrom`](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439); [code@6ee4a5c `src/application/access/scoped-session.ts#L288`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/access/scoped-session.ts#L288) `restoredFrom` makes the recorder close the autosave before and after |

## Implementation gaps

- 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9: Partly built as of 6ee4a5c: a settings restore lists removed or renamed viewport and theme keys with the threads whose render context names them, and the formal Evidence that would become stale under the freshness Rules evaluated today ([code@6ee4a5c `src/domain/impact/analyzer.ts#L266`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/domain/impact/analyzer.ts#L266); [code@6ee4a5c `src/domain/impact/analyzer.ts#L285`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/domain/impact/analyzer.ts#L285)); Evidence made stale through a changed `adapters` selection, order or configuration is not listed until Adapter provenance lands (issues #57 and #92; owner ruling 5 of https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439); tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-17f7-7bdf-8cec-24fea8c348b2: Partly built as of 6ee4a5c: a restore gives Evidence no special treatment, so Evidence captured at the restored revision is fresh again only when the freshness Rules evaluated on read hold; Adapter provenance is not yet one of them (issues #57 and #92); tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11c09-c648-71be-a550-2ecabf12f5d0: Partly built as of 6ee4a5c: a restore is authorized for `restoreResourceVersion` and for the authoring operation that stands for the restored kind's write key ([code@6ee4a5c `src/application/access/policy.ts#L130`](https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/src/application/access/policy.ts#L130) `writeOperationForKind`), but access is a role matrix, not keys; tracked in issue #142 (https://github.com/DevilTea/uiux/issues/142).

## Notes

- The `restore_resource_version` input and results are owned by 01a11a5e-2768-76ad-b02a-e15f50f91268; the Editor role by 01a11485-fa44-7b6a-99f8-de4e1e8edcfc; Restore on desktop only by 01a11a5e-1bfa-71e9-9611-152b5b665379. Leases apply as to any write (01a11485-f005-7f10-baf7-58cb17e5d0e1, and an Agent's restore takes the lease by 01a11485-f020-74e0-b721-b4d6a5d15195), and a restore is a mutation, so 01a1144e-4fcf-7b8a-8978-73b1a0cc31f4 already refuses it while the Workspace needs migration or is unsupported.
- Whole-version revert (decision 10-B) is deferred by the owner (O2) to its own later decision.
- Decision 10 rule 4 (R16) notes a derived consequence of 01a11a5e-1645-7f02-ae9e-05dd242e4a82: restore is the first operation that can change a View's `name` (no rename operation exists yet, #56); identity never changes.
- Decision 10 rule 8 lets a restore re-create a resource that disappeared out of band. The owner settled how `expectedRevision` is supplied for a missing resource as `null` (ruling 3 of https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439); Clause 01a11a5e-2768-76ad-b02a-e15f50f91268 records it.
