Feature: Product Kit
  # Source: Discussion #139 (Part 14, Product Kit), decision 9, A: Drift; R12; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 2f7e092; see the Implementation gaps entry of 01a11bb1-a630-7c7c-8dd3-5e0a11e4e919 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c24c-73ad-814c-afc65ba50011
  @spec:demonstrates:01a11bb1-8c9b-78a8-b359-c083412d9789
  @spec:demonstrates:01a11bb1-a630-7c7c-8dd3-5e0a11e4e919
  Scenario: Editing the original component is reported as upstream
    Given a product project with a recorded copy of `button`
    When a kit author edits `kit/src/ds/Button.vue` in the Workspace
    When the developer runs `uiux components diff`
    Then the file is reported `upstream`
