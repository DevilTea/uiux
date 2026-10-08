Feature: Product Kit
  # Source: Discussion #139 (Part 14, Product Kit), owner ruling 1 of 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18817697; decision 9, A, copy-record example https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 9691b8c; see the Implementation gaps entry of 01a11bb1-a4a6-7baf-8b27-e154f8e84356 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11be8-5a84-78f6-9bbb-b24985d42c5b
  @spec:demonstrates:01a11bb1-a4a6-7baf-8b27-e154f8e84356
  Scenario: A required component recorded at another target directory makes the copy refuse
    Given a product project whose copy record lists `button` with the target `src/ui`
    Given a registry component `order-summary-card` that requires `button`
    When a developer runs `uiux components add order-summary-card --to src/features/orders` without `--force`
    Then the command is refused with a message naming the recorded target `src/ui`
    Then no file of the product project changes
