Feature: A remote reply while drafting shows an updated-by-others notice and keeps the draft
  # Source: issue #80 (https://github.com/DevilTea/uiux/issues/80). Decisions behind the demonstrated Rule: #1 c176 d6 rule 2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@d5496ac `tests/review-updated-by-others-browser.test.ts#L117` "in ${name}: acknowledging moves the draft to the fresh revision", run for the Reviews detail and the canvas thread bubble. https://github.com/DevilTea/uiux/blob/d5496ac467e60b5ddc540fa9d21a1a985aa3a552/tests/review-updated-by-others-browser.test.ts#L117
  # Test: code@d5496ac `tests/review-updated-by-others-browser.test.ts#L139` "in ${name}: sending without acknowledging is refused and keeps the draft", run for the Reviews detail and the canvas thread bubble. https://github.com/DevilTea/uiux/blob/d5496ac467e60b5ddc540fa9d21a1a985aa3a552/tests/review-updated-by-others-browser.test.ts#L139
  # Status: built as of d5496ac.
  @spec:id:01a16369-2dca-7310-b1e7-79ac48ce3506
  @spec:demonstrates:01a11485-f434-75ed-ab0a-e321468c8407
  Scenario: A remote reply while drafting shows an updated-by-others notice and keeps the draft
    Given a member is drafting a reply to a Review thread in the Workbench
    When an Agent replies to that thread through MCP
    Then the member's draft is kept
    Then a notice above the composer says the thread was updated by others with 1 new reply
