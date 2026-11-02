---
id: 01a19b99-cb2f-76fb-add5-2ede8d0aebdd
title: View thumbnail records
summary: "The exact values of View thumbnails: the host-local cache path and
  modes, the image, the thumbnail input digest, the state values, the quiet
  period, ceiling, queue limit and failure interval, the change event that
  announces them and the caching of a read response."
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
      exactly 480 px wide, and its height is 480 times the viewport preset's
      height divided by its width, rounded half up to a whole pixel.
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
    statement: The quiet period is 10 seconds, the ceiling is 60 seconds, the
      in-flight limit is 1 thumbnail capture, and the failure interval is 60
      seconds.
  - id: 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7
    statement: Beside the events of Clause 01a114ec-e839-7b11-957c-41c88b692e12, the
      change-event stream sends `thumbnail.changed` with the field `key`, the
      View's key, and no other field.
    constrains:
      - 01a111e4-0315-7755-b867-e3c7b50d22e6
      - 01a19b99-c9ee-7dcb-ae96-bbe31f12591c
      - 01a19b99-ca97-7aa7-b326-345c8a26caf3
  - id: 01a19bb9-8e8a-7775-b19b-76e0b855095c
    statement: "A thumbnail read response carries the header `Cache-Control: no-store`."
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
| 01a19b99-cbd0-7076-b286-a6cee12af0f3 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): decision 1 (host-local cache) and the design's "Cache location and key"; the roster path of Clause 01a11485-f874-73b4-8b0f-2295c21e9085 and host history of Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0 are the precedent; modes as for the roster store (Clause 01a114ec-e9e6-7cbc-b0da-8e4daa3d195e); built as of a2b2a01: [code@a2b2a01 `src/server/thumbnail-store.ts#L11-L13`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/server/thumbnail-store.ts#L11-L13) `thumbnailsDirectory`, [code@a2b2a01 `src/server/thumbnail-store.ts#L24-L119`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/server/thumbnail-store.ts#L24-L119) `createThumbnailStore` |
| 01a19b99-cc6d-7bf7-9f15-5250944e198f | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Image": PNG because the dependencies hold no WebP encoder (`package.json`, no `sharp`) and Playwright encodes only PNG and JPEG ([code@be419253 `src/application/services/capture-harness.ts#L207-L209`](https://github.com/DevilTea/uiux/blob/be419253f49a8d069386404acccddca3057f4208/src/application/services/capture-harness.ts#L207-L209), viewport only); amended by the review of PR #482 (https://github.com/DevilTea/uiux/pull/482): exactly 480 px, rounded half up; built as of a2b2a01: [code@a2b2a01 `src/domain/thumbnails/digest.ts#L56-L58`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/domain/thumbnails/digest.ts#L56-L58) `thumbnailHeight`, [code@a2b2a01 `src/application/services/thumbnail-capture.ts#L63-L67`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/services/thumbnail-capture.ts#L63-L67) the size check, [code@a2b2a01 `src/application/services/capture-harness.ts#L170`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/services/capture-harness.ts#L170) `deviceScaleFactor` |
| 01a19b99-ccfa-74bb-9671-08ab5d4e2656 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Cache location and key"; the encoding is that of [code@be419253 `src/domain/evidence/render-input-digest.ts#L15`](https://github.com/DevilTea/uiux/blob/be419253f49a8d069386404acccddca3057f4208/src/domain/evidence/render-input-digest.ts#L15) and the provenance those of formal capture records (Clauses 01a11bb1-8fc4-7b7d-87da-d3fc5d457d98 and 01a1161c-008a-746d-8d53-a8301b23588f); built as of a2b2a01: [code@a2b2a01 `src/domain/thumbnails/digest.ts#L31-L42`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/domain/thumbnails/digest.ts#L31-L42) `thumbnailInputDigest`, [code@a2b2a01 `src/application/services/thumbnail-inputs.ts#L53-L61`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/services/thumbnail-inputs.ts#L53-L61) its inputs |
| 01a19b99-cd8b-7a8d-a357-5a55fa9453d7 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Cache location and key" (fresh, stale, missing) and "Reading" (refreshing); amended by the re-review of PR #482 (https://github.com/DevilTea/uiux/pull/482): values only; the held-back exclusion of `refreshing` is in Rule 01a19b99-d985-7c77-9420-1c5a19db7c69; built as of a2b2a01: [code@a2b2a01 `src/application/ports/thumbnails.ts#L11`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/ports/thumbnails.ts#L11) `ThumbnailState`, [code@a2b2a01 `src/application/ports/thumbnails.ts#L14`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/ports/thumbnails.ts#L14) `ThumbnailStatus` |
| 01a19b99-ce21-7b2c-b039-f9afa8f95a97 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): decision 2 (about 10 s of quiet, at most one capture in flight) and the design's "Trigger, debounce, queue" (60 seconds before a request queues a failed View again); amended by [#480 owner answers 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the three answers](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347706): the 60 s ceiling (answer 1); amended by the review of PR #482 (https://github.com/DevilTea/uiux/pull/482): values only; the behaviors are Rules 01a19bac-ea4d-79eb-9c1b-0c887270b5d5, 01a19b99-d760-7e54-9a5e-1d98e9306de7 and 01a19b99-d509-708b-8d53-ac59f3ea0413; built as of a2b2a01: [code@a2b2a01 `src/application/services/thumbnails.ts#L21-L23`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/services/thumbnails.ts#L21-L23) the four values |
| 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7 | [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480): the design's "Event"; the stream and its other events are Clause 01a114ec-e839-7b11-957c-41c88b692e12 ([code@be419253 `src/application/services/change-events.ts#L17-L21`](https://github.com/DevilTea/uiux/blob/be419253f49a8d069386404acccddca3057f4208/src/application/services/change-events.ts#L17-L21) `ChangeEvent`); constrains Feature 01a111e4-0315-7755-b867-e3c7b50d22e6 too; placement confirmed by [#480 owner decisions from the review of PR #482, 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the event as a new Clause; the digest keeps Variants](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347934); built as of a2b2a01: [code@a2b2a01 `src/application/services/change-events.ts#L23`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/application/services/change-events.ts#L23) `ChangeEvent`, [code@a2b2a01 `src/server/event-stream.ts#L207`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/server/event-stream.ts#L207) `changeEventFrame` |
| 01a19bb9-8e8a-7775-b19b-76e0b855095c | the review of PR #482 (https://github.com/DevilTea/uiux/pull/482): a browser copy of a thumbnail would outlive the loss of `workspace.read` (Rule 01a19bb9-9685-7bbf-ab29-a22032c91c64); built as of a2b2a01: [code@a2b2a01 `src/server/thumbnails-http.ts#L14-L18`](https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/src/server/thumbnails-http.ts#L14-L18) `readThumbnailForHttp` |

## Notes

- Why a Contract: the cache values, the digest, the state values and the event are shared by the server Feature 01a19b99-c9ee-7dcb-ae96-bbe31f12591c and the Workbench Feature 01a19b99-ca97-7aa7-b326-345c8a26caf3 and change independently of both.
- Clause 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7 stands beside Clause 01a114ec-e839-7b11-957c-41c88b692e12 (Mutation and revision semantics Contract) instead of amending it, so that built Clause and its Scenario stay unchanged; it also constrains Feature 01a111e4-0315-7755-b867-e3c7b50d22e6 (Live refresh). The key is Clause 01a19bb9-8f1f-7482-b6fd-f131a284178e of the Access control Contract. Both placements are confirmed by [#480 owner decisions from the review of PR #482, 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the event as a new Clause; the digest keeps Variants](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347934).
- There is no HTTP Contract (owner ruling Q4): no route is named here.
- The digest keeps Variants through the View's render-input digest (Clause 01a14e30-2d4a-7ce9-ad68-58db56f36f47 covers `ir` and `variants`), so a Variant-only edit re-captures the base thumbnail, a harmless extra capture; the thumbnail never shows a Variant ([#480 owner decisions from the review of PR #482, 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the event as a new Clause; the digest keeps Variants](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347934)).
