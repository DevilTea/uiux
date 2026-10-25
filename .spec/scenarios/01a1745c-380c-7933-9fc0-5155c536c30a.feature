Feature: Handoff export
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 9, R34 and R35 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@167195a `tests/handoff-closure.test.ts#L1089` "snapshots mapped files with their package, revision and path, and marks the others provenance-only or unavailable without blocking". https://github.com/DevilTea/uiux/blob/167195a6e7b0b8e0e10f7771739219f90def8926/tests/handoff-closure.test.ts#L1089
  # Test: code@167195a `tests/handoff-closure.test.ts#L1141` "marks a mapped path that leaves its root through a link unavailable". https://github.com/DevilTea/uiux/blob/167195a6e7b0b8e0e10f7771739219f90def8926/tests/handoff-closure.test.ts#L1141
  # Status: built as of 167195a.
  @spec:id:01a1745c-380c-7d60-b4ae-25327be5873f
  @spec:demonstrates:01a11a5a-58c6-70bd-9a05-54e533e57c53
  @spec:demonstrates:01a11a5a-594b-74b6-92af-dce82ecfeaef
  @spec:demonstrates:01a11add-f389-70cc-8449-6ae596044963
  Scenario: A mapped source that is missing or marked not to embed is marked and never blocks readiness
    Given an Adapter whose source mapping names a missing file, a file marked not to embed and a URL
    When a Handoff bundle is exported for a View that uses that Widget type
    Then the missing file is unavailable
    Then the file marked not to embed and the URL are provenance-only
    Then no blocking diagnostic names them
