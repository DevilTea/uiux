Feature: A reply draft moves to the fresh revision only when the updated-by-others notice is acknowledged
  # Source: issue #80 (https://github.com/DevilTea/uiux/issues/80). Decisions behind the demonstrated Rule: #1 c176 d6 rule 2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@d5496ac `tests/review-updated-by-others-browser.test.ts#L117` "in ${name}: acknowledging moves the draft to the fresh revision", run for the Reviews detail and the canvas thread bubble. https://github.com/DevilTea/uiux/blob/d5496ac467e60b5ddc540fa9d21a1a985aa3a552/tests/review-updated-by-others-browser.test.ts#L117
  # Status: built as of d5496ac.
  @spec:id:01a16369-46eb-7973-af73-af53bb68b0aa
  @spec:demonstrates:01a11485-f434-75ed-ab0a-e321468c8407
  Scenario: A reply draft moves to the fresh revision only when the updated-by-others notice is acknowledged
    Given a member is drafting a reply to a Review thread in the Workbench
    Given an Agent replied to that thread meanwhile and the updated-by-others notice is shown
    When the member acknowledges the notice
    When the member sends the reply
    Then the reply is added to the thread against its fresh revision
