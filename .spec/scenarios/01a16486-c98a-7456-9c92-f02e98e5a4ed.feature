Feature: Review lifecycle and resolution
  # Source: Discussion #10 comment 4 (2026-10-07), owner ruling on issue #57 https://github.com/DevilTea/uiux/discussions/10#discussioncomment-18793180, decision 4.
  # Test: code@a850cd1 `tests/review-scope-and-edit.test.ts#L554` "refuses a capture whose freshness is unknown and keeps the thread open". https://github.com/DevilTea/uiux/blob/a850cd1bb44bb1c02624381eb9c7584554a257ad/tests/review-scope-and-edit.test.ts#L554
  # Test: code@a850cd1 `tests/handoff-closure.test.ts#L1713` "gives a capture that records no Adapter provenance unknown freshness, which Handoff does not accept". https://github.com/DevilTea/uiux/blob/a850cd1bb44bb1c02624381eb9c7584554a257ad/tests/handoff-closure.test.ts#L1713
  # Status: built as of 881f266.
  @spec:id:01a16486-c98a-754a-a90e-a5b4920259da
  @spec:demonstrates:01a1161b-ff68-76af-8237-dbc8ef2c27d1
  @spec:demonstrates:01a11686-8d71-79f5-bb10-0c74649586ea
  Scenario: Marking a thread ready refuses a capture that records no Adapter provenance
    Given a formal capture of a View recorded without Adapter provenance
    Given an open thread anchored to a Widget of that View
    When an Agent marks the thread ready for review citing that capture
    Then marking ready is refused because the capture has unknown freshness
    Then the thread stays open
