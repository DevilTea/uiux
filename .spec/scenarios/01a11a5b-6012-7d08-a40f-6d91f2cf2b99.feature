Feature: Preview failure diagnostics
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 9 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #111.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a59-def9-797a-8d08-5e4b02ecd900 in its owner.
  @spec:id:01a11a5b-6012-774b-8a16-a6d1aeb57d5a
  @spec:demonstrates:01a11687-3650-7490-a7ec-80b2570582f6
  @spec:demonstrates:01a11a59-def9-797a-8d08-5e4b02ecd900
  Scenario: A work-scoped failure report latches refinement and keeps the geometry stream
    Given a Preview runtime that declares failure reports is refining a Widget's contour
    When the runtime reports that refinement's `sequence` as permanently unavailable
    Then the Workbench starts no new refinement within that geometry revision
    Then the Widget's geometry stream and the runtime generation stay live
