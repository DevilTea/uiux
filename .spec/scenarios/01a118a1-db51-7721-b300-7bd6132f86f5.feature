Feature: Prototype playback
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #6 c8 R17 https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18760681; #2 c37 d6 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18760678; #3 c7 https://github.com/DevilTea/uiux/discussions/3#discussioncomment-18760683; #3 c6 item 2.5, T8 https://github.com/DevilTea/uiux/discussions/3#discussioncomment-18760674.
  # Test: code@a021f9e `tests/widget-events-browser.test.ts#L172` "disarms for comment mode during playback, drops what happens there, and re-arms on exit". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/widget-events-browser.test.ts#L172
  # Status: built as of a021f9e.
  @spec:id:01a118a1-db51-78fe-9305-76dd3fdfc923
  @spec:demonstrates:01a11544-6585-7110-acc9-c3109c329f84
  @spec:demonstrates:01a11658-2288-718c-a87e-20f6ded1b85c
  Scenario: Comment mode during playback drops Widget Events
    Given a Prototype is playing
    When the Reviewer turns on Comment mode and clicks a trigger Widget
    When the Reviewer leaves Comment mode
    Then the player has not advanced
    Then the click is not replayed afterwards
