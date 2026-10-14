Feature: Product Kit
  # Source: Discussion #139 (Part 14, Product Kit), decision 9, A: Copy record; R11; owner pre-answer P23; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: built as of 0d30bb6.
  # Test: code@0d30bb6 `tests/components-cli.test.ts#L189` "adds a component copied to another directory to the same copy record". https://github.com/DevilTea/uiux/blob/0d30bb62bc68e0dabb04666d77bf0a84c928ff15/tests/components-cli.test.ts#L189
  @spec:id:01a11bb1-c182-7ae7-9b5a-5fdd3684ecee
  @spec:demonstrates:01a11bb1-a3de-7426-94d2-c0e2bdd0be72
  Scenario: A component copied to another directory joins the same copy record
    Given a product project whose copy record lists `button` with the target `src/ui`
    Given a registry component `badge` that requires no other component
    When a developer runs `uiux components add badge --to src/features/orders` in the product project
    Then the same `uiux-components.json` lists `button` and `badge`, each with its own target directory
