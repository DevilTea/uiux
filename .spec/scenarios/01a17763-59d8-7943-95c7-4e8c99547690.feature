Feature: A replay clicks a Button and asserts its declared Widget Event
  # Source: Discussion #241 owner rulings 2026-10-26 (#89 replayable interaction Evidence) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19191424, ruling 1.
  # Test: code@5e54a19 `tests/interaction-evidence-browser.test.ts#L72` "clicks the real Button and records that the declared Widget Event was observed, with its capture". https://github.com/DevilTea/uiux/blob/5e54a19/tests/interaction-evidence-browser.test.ts#L72
  # Status: built as of 5e54a19.
  @spec:id:01a17763-59d7-7459-abec-7c876d9a8b71
  @spec:demonstrates:01a11544-66d9-7fcd-8400-93516ddf2857
  @spec:demonstrates:01a115cd-c507-738d-abd7-7a4194761319
  @spec:demonstrates:01a17762-b467-7da6-9a61-59c1af1ba6af
  @spec:demonstrates:01a17762-b85b-77d6-a399-e26843475501
  Scenario: A replay clicks a Button and asserts its declared Widget Event
    Given a View with a Button that declares the Event click
    When an Agent captures interaction Evidence that clicks the Button and asserts the Event click
    Then the replay dispatches a real click on the rendered Button
    Then the stored record marks the assertion as pass and references the formal capture
