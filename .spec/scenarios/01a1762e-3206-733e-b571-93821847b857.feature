Feature: Visible Widget geometry
  # Source: issue #110 (https://github.com/DevilTea/uiux/issues/110). Decisions behind the demonstrated Rules and Clauses: #1 c113 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18634281; #1 c115 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18634504; #1 c117 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18635518.
  # Test: code@7eceb6a `tests/preview-contour-refinement.test.ts#L241` "retries a rejected partial refinement once with the full original region set, then regenerates". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-refinement.test.ts#L241
  # Test: code@7eceb6a `tests/contour-refinement-browser.test.ts#L202` "retries a rejected refinement once, then regenerates, then stops without latching or flooding". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/contour-refinement-browser.test.ts#L202
  # Status: built as of 7eceb6a.
  @spec:id:01a1762e-3206-7998-84ec-3290f7183e0f
  @spec:demonstrates:01a11687-34ba-7318-be3c-0ba1348b3063
  @spec:demonstrates:01a11687-34ff-75b5-9f7a-f7b8abf922f4
  @spec:demonstrates:01a11687-3543-7738-a0bc-690610c77148
  Scenario: A rejected partial refinement is retried once and then regenerated completely
    Given a partial refinement is pending for the regions that miss the display tolerance
    When the runtime answers it with a contour whose error bound misses the requested precision
    When the runtime answers the retry the same way
    Then the Workbench rejects each response whole and credits nothing of it
    Then the Workbench sends one retry for the full original region set and then a complete contour regeneration
