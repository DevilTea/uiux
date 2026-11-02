---
id: 01a19b99-cb2f-76fb-add5-2ede8d0aebdd
title: View thumbnail records
summary: "The exact values of View thumbnails: the host-local cache path and
  modes, the image, the thumbnail input digest, the state values, the quiet
  period, queue and failure interval, the access they need and the change event
  that announces them."
clauses:
  - id: 01a19b99-cbd0-7076-b286-a6cee12af0f3
    statement: A View's thumbnail is the file
      `$UIUX_HOME/workspaces/<wsid>/thumbnails/<viewId>/<digest>.png`, where
      `<wsid>` is the one of Clause 01a11485-f874-73b4-8b0f-2295c21e9085,
      `<viewId>` is the View's key and `<digest>` is the 64 hex digits of its
      thumbnail input digest; the directories have mode 0700 and the files mode
      0600.
  - id: 01a19b99-cc6d-7bf7-9f15-5250944e198f
    statement: A thumbnail is a PNG of the viewport only, never of the full page,
      480 px wide, and its height is 480 times the viewport preset's height
      divided by its width, rounded to a whole pixel.
  - id: 01a19b99-ccfa-74bb-9671-08ab5d4e2656
    statement: "The thumbnail input digest is `sha256:<hex>` over the canonical
      JSON, encoded as the render-input digest of Clause
      01a14e30-2d4a-7ce9-ad68-58db56f36f47 is, of `{ renderInputDigest, locale:
      { id, revision }, viewport: { id, width, height }, themeId, adapters,
      productKit, assets }`: `renderInputDigest` is the View's own, `adapters`
      and `productKit` are the current Adapter and Product Kit provenance that a
      formal capture records, and `assets` maps the id of each Asset the View
      binds to its revision."
  - id: 01a19b99-cd8b-7a8d-a357-5a55fa9453d7
    statement: A thumbnail's state is `fresh`, `stale` or `missing`, and a View is
      `refreshing` while its thumbnail is queued or in flight.
  - id: 01a19b99-ce21-7b2c-b039-f9afa8f95a97
    statement: The quiet period is 10 seconds, a capture pass starts at the latest
      60 seconds after the first change that no pass has yet covered, at most 1
      thumbnail capture is in flight, and a request does not queue a View whose
      thumbnail capture failed less than 60 seconds ago.
  - id: 01a19b99-ceaf-72dc-aa2e-3df1a71c5ca9
    statement: Reading a View's thumbnail, listing the thumbnail states and
      requesting thumbnails each need the permission key `workspace.read` and no
      other key.
  - id: 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7
    statement: Beside the events of Clause 01a114ec-e839-7b11-957c-41c88b692e12, the
      change-event stream sends `thumbnail.changed` with the field `key`, the
      View's key, and no other field.
constrains:
  - 01a19b99-c9ee-7dcb-ae96-bbe31f12591c
  - 01a19b99-ca97-7aa7-b326-345c8a26caf3
---

## Sources

- Discussion #480 (2026-11-02), "Proposal: View thumbnails and a grid Views list", with the owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design. https://github.com/DevilTea/uiux/discussions/480
- Issue #481 (2026-11-02), "View thumbnails and grid Views list", the implementation checklist. https://github.com/DevilTea/uiux/issues/481
- code@be419253 (the capture engine, the freshness inputs, the change events and the Views tab that the design builds on, cited per Rule below). https://github.com/DevilTea/uiux/tree/be419253f49a8d069386404acccddca3057f4208

## Rule sources

| Clause | Sources |
| --- | --- |
| 01a19b99-cbd0-7076-b286-a6cee12af0f3 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): decision 1 (host-local cache) and the design's "Cache location and key"; the roster path of Clause 01a11485-f874-73b4-8b0f-2295c21e9085 and host history of Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0 are the precedent; modes as for the roster store (Clause 01a114ec-e9e6-7cbc-b0da-8e4daa3d195e) |
| 01a19b99-cc6d-7bf7-9f15-5250944e198f | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Image": PNG because the dependencies hold no WebP encoder (`package.json`, no `sharp`) and Playwright encodes only PNG and JPEG ([code@be419253 `src/application/services/capture-harness.ts#L207-L209`](https://github.com/DevilTea/uiux/blob/be419253f49a8d069386404acccddca3057f4208/src/application/services/capture-harness.ts#L207-L209), viewport only) |
| 01a19b99-ccfa-74bb-9671-08ab5d4e2656 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Cache location and key"; the encoding is that of [code@be419253 `src/domain/evidence/render-input-digest.ts#L15`](https://github.com/DevilTea/uiux/blob/be419253f49a8d069386404acccddca3057f4208/src/domain/evidence/render-input-digest.ts#L15) and the provenance those of formal capture records (Clauses 01a11bb1-8fc4-7b7d-87da-d3fc5d457d98 and 01a1161c-008a-746d-8d53-a8301b23588f) |
| 01a19b99-cd8b-7a8d-a357-5a55fa9453d7 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Cache location and key" (fresh, stale, missing) and "Reading" (refreshing) |
| 01a19b99-ce21-7b2c-b039-f9afa8f95a97 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): decision 2 (about 10 s of quiet, at most one capture in flight) and the design's "Trigger, debounce, queue" (60 seconds before a request queues a failed View again); amended by [#480 owner answers 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the three answers](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347706): the 60 s ceiling (answer 1) |
| 01a19b99-ceaf-72dc-aa2e-3df1a71c5ca9 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Reading": reading a thumbnail needs `workspace.read` and capture is server-internal; the key table is Clause 01a11485-fa00-72da-bc46-98302a3c106e, the system credential allowlist Clause 01a11c09-a3bb-7ad4-a889-d50b124d3679 |
| 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Event"; the stream and its other events are Clause 01a114ec-e839-7b11-957c-41c88b692e12 ([code@be419253 `src/application/services/change-events.ts#L17-L21`](https://github.com/DevilTea/uiux/blob/be419253f49a8d069386404acccddca3057f4208/src/application/services/change-events.ts#L17-L21) `ChangeEvent`) |

## Implementation gaps

- 01a19b99-cbd0-7076-b286-a6cee12af0f3: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
- 01a19b99-cc6d-7bf7-9f15-5250944e198f: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
- 01a19b99-ccfa-74bb-9671-08ab5d4e2656: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
- 01a19b99-cd8b-7a8d-a357-5a55fa9453d7: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
- 01a19b99-ce21-7b2c-b039-f9afa8f95a97: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
- 01a19b99-ceaf-72dc-aa2e-3df1a71c5ca9: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
- 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).

## Notes

- Why a Contract: the cache values, the digest, the state values and the event are shared by the server Feature 01a19b99-c9ee-7dcb-ae96-bbe31f12591c and the Workbench Feature 01a19b99-ca97-7aa7-b326-345c8a26caf3 and change independently of both.
- Clauses 01a19b99-ceaf-72dc-aa2e-3df1a71c5ca9 and 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7 stand beside Clause 01a11485-fa00-72da-bc46-98302a3c106e (Access control Contract) and Clause 01a114ec-e839-7b11-957c-41c88b692e12 (Mutation and revision semantics Contract) instead of amending them, so that those built Clauses and their Scenarios stay unchanged. Discussion #480 names them as amended; a comment there records the placement.
- There is no HTTP Contract (owner ruling Q4): no route is named here.
