Feature: Product Kit
  # Source: Discussion #139 (Part 14, Product Kit), decision 9, A: Drift; R12; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 9691b8c; see the Implementation gaps entry of 01a11bb1-a630-7c7c-8dd3-5e0a11e4e919 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c1e6-7fdf-bcae-6579414fab33
  @spec:demonstrates:01a11bb1-8c9b-78a8-b359-c083412d9789
  @spec:demonstrates:01a11bb1-9bef-7d8f-8577-c525dd917149
  @spec:demonstrates:01a11bb1-a630-7c7c-8dd3-5e0a11e4e919
  Scenario: Editing a copied file is reported as modified
    Given a product project with a recorded copy of `button`
    When a developer edits the copied `Button.vue`
    When the developer runs `uiux components diff --check`
    Then the edited file is reported `modified`
    Then the command exits with status 1
