Feature: Visible Widget geometry
  # Source: issue #356 (https://github.com/DevilTea/uiux/issues/356); #241 owner ruling 2 of 2026-10-26, the single bounded wait of 5000 ms for a partial refinement request, a complete regeneration unlimited. https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: code@0374f28 `tests/preview-contour-refinement.test.ts#L320` "waits the whole limit, then cancels the partial request and retries it once with the full original region set". https://github.com/DevilTea/uiux/blob/0374f28c2ec8abf164c342aa306c7385417f6cb2/tests/preview-contour-refinement.test.ts#L320
  # Test: code@0374f28 `tests/preview-contour-refinement.test.ts#L336` "regenerates completely when the retry is interrupted too, and never times a regeneration". https://github.com/DevilTea/uiux/blob/0374f28c2ec8abf164c342aa306c7385417f6cb2/tests/preview-contour-refinement.test.ts#L336
  # Status: built as of 0374f28 (issue #356).
  @spec:id:01a178c3-e5b2-71a3-8158-025a411b30bb
  @spec:demonstrates:01a11687-3543-7738-a0bc-690610c77148
  @spec:demonstrates:01a178bc-6de6-7baa-8e4a-a00a0c73f378
  Scenario: An unanswered partial contour request is retried once, then regenerated
    Given the Workbench has sent a `contour.partial.request` for a Widget and the runtime never answers it
    When 5000 ms pass without a verifiable response
    When the one retry is left unanswered for another 5000 ms
    Then the Workbench canceled each unanswered request best effort and sent exactly one retry with the full original region set
    Then the Workbench then sent a `contour.full.request`, which it waits for without a limit
