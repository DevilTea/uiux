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
---

## Sources

- Discussion #122 body (2026-10-06, accepted as written on 2026-10-08), "UIUX Architecture Decisions — Part 11: Workspace Version Timeline": decisions 1-13, Proposed defaults R1-R34, Amended decisions and "What `.spec/` records after acceptance". https://github.com/DevilTea/uiux/discussions/122
- Discussion #122 comment (2026-10-08), "Owner acceptance — 2026-10-08": decisions 1-13 and every Proposed default R1-R34 accepted as stated; R33 (timeline in Overview › Activity, View-page `history` panel, selections in the address) and R34 (Restore on desktop only) confirmed. https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263
- Owner pre-answers O1-O7 (2026-10-06), folded into the Discussion #122 body: O1 hybrid storage, O2 single-resource restore, O3 Reviewer+ checkpoints, O4 fixed grouping and retention, O5 no history in the publication, O6 no Git `HEAD`, O7 no automatic checkpoint at task end. https://github.com/DevilTea/uiux/discussions/122

## Rule sources

| Rule | Sources |
| --- | --- |
| 01a11a5e-1428-70eb-9d75-b54ba25015cb | [#122 body: decision 10, A](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R17](https://github.com/DevilTea/uiux/discussions/122); owner pre-answer O2 (2026-10-06, [#122 body: Owner answers of 2026-10-06](https://github.com/DevilTea/uiux/discussions/122)); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-147c-79e2-82d6-85df8b6f0e34 | [#122 body: decision 10, A, B deferred](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R17](https://github.com/DevilTea/uiux/discussions/122); owner pre-answer O2 (2026-10-06, [#122 body: Owner answers of 2026-10-06](https://github.com/DevilTea/uiux/discussions/122)); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-14ce-7894-9c46-a8ad4b45e6d6 | [#122 body: decision 10, A: `restoredFrom`](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-1520-78ac-a711-6e51c54c2079 | [#122 body: decision 10, rules 1, 2](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R18](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-1580-7908-9f77-98667dc2e96f | [#122 body: decision 10, rule 3](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-15e9-797f-9a1c-1e6ea5b7c431 | [#122 body: decision 10, rule 3](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R32](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-1645-7f02-ae9e-05dd242e4a82 | [#122 body: decision 10, rule 4](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R16](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-16a2-7c0b-9495-3dae49e9dda3 | [#122 body: decision 10, rule 8](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-16f7-7229-8d17-587490168f1f | [#122 body: decision 10, rule 5](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-174b-7e74-b232-5ec76601fbed | [#122 body: decision 10, rule 5](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9 | [#122 body: decision 10, rule 5](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Interactions 1](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Interactions 2](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263); "configuration" aligned with the Evidence freshness Rule 01a115cd-c6de-7744-be27-715bec2e7fef as amended by Part 12 ([#130 acceptance](https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264)) |
| 01a11a5e-17f7-7bdf-8cec-24fea8c348b2 | [#122 body: decision 10, rule 6](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Interactions 2](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-184c-7184-bb0b-781744e6a1ca | [#122 body: decision 10, rule 7](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-189f-7b86-8270-e9b5d62aaa65 | [#122 body: decision 10, rule 9](https://github.com/DevilTea/uiux/discussions/122); [#122 body: decision 2](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |
| 01a11a5e-18f2-7991-8f7d-aa4c8015d14a | [#122 body: decision 11, Workbench: Restore](https://github.com/DevilTea/uiux/discussions/122); [#122 body: Proposed defaults R34](https://github.com/DevilTea/uiux/discussions/122); [#122 acceptance](https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263) |

## Implementation gaps

- 01a11a5e-1428-70eb-9d75-b54ba25015cb: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-147c-79e2-82d6-85df8b6f0e34: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-14ce-7894-9c46-a8ad4b45e6d6: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-1520-78ac-a711-6e51c54c2079: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-1580-7908-9f77-98667dc2e96f: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-15e9-797f-9a1c-1e6ea5b7c431: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-1645-7f02-ae9e-05dd242e4a82: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-16a2-7c0b-9495-3dae49e9dda3: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-16f7-7229-8d17-587490168f1f: Not built as of cf3b984: no version history exists; it also needs the reference-impact analysis tracked in issue #75 (https://github.com/DevilTea/uiux/issues/75); tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-174b-7e74-b232-5ec76601fbed: Not built as of cf3b984: no version history exists; it also needs the reference-impact analysis tracked in issue #75 (https://github.com/DevilTea/uiux/issues/75); tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9: Not built as of cf3b984: no version history exists; it also needs the reference-impact analysis tracked in issue #75 (https://github.com/DevilTea/uiux/issues/75); tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-17f7-7bdf-8cec-24fea8c348b2: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-184c-7184-bb0b-781744e6a1ca: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-189f-7b86-8270-e9b5d62aaa65: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).
- 01a11a5e-18f2-7991-8f7d-aa4c8015d14a: Not built as of cf3b984: no version history exists; tracked in issue #132 (https://github.com/DevilTea/uiux/issues/132).

## Notes

- The `restore_resource_version` input and results are owned by 01a11a5e-2768-76ad-b02a-e15f50f91268; the Editor role by 01a11485-fa44-7b6a-99f8-de4e1e8edcfc; Restore on desktop only by 01a11a5e-1bfa-71e9-9611-152b5b665379. Leases apply as to any write (01a11485-f005-7f10-baf7-58cb17e5d0e1, and an Agent's restore takes the lease by 01a11485-f020-74e0-b721-b4d6a5d15195), and a restore is a mutation, so 01a1144e-4fcf-7b8a-8978-73b1a0cc31f4 already refuses it while the Workspace needs migration or is unsupported.
- Whole-version revert (decision 10-B) is deferred by the owner (O2) to its own later decision.
- Decision 10 rule 4 (R16) notes a derived consequence of 01a11a5e-1645-7f02-ae9e-05dd242e4a82: restore is the first operation that can change a View's `name` (no rename operation exists yet, #56); identity never changes.
- Decision 10 rule 8 lets a restore re-create a resource that disappeared out of band; how `expectedRevision` is supplied for a missing resource is left to implementation.
