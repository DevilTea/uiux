Feature: A Decision is deferred, decided and reopened
  # Source: Owner rulings 2026-10-25 (#86 Decision lifecycle) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19175269.
  # Test: code@bd59929 `tests/decision-lifecycle.test.ts#L116` "defers, decides and reopens one Decision in place, each appending a history entry with the stamped actor". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle.test.ts#L116
  # Test: code@bd59929 `tests/decision-lifecycle-browser.test.ts#L73` "defers, decides and reopens a Decision on the Spec tab, keeping its place and recording history". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle-browser.test.ts#L73
  # Status: built as of bd59929.
  @spec:id:01a17233-f55e-77a9-9ae4-638b52cb93d2
  @spec:demonstrates:01a11544-5e99-789d-bfed-dda22a98776f
  @spec:demonstrates:01a11544-5ec3-73ae-b122-ed8387eff75b
  @spec:demonstrates:01a11544-5eee-7ebe-90f1-14e954dbd7f9
  @spec:demonstrates:01a17226-fafc-7691-99ff-aa3b20f5836f
  Scenario: A Decision is deferred, decided and reopened
    Given a View whose Spec holds a pending Decision
    When a member holding views.write defers it
    When a human member holding decisions.decide decides it with an outcome
    When a member holding views.write reopens it
    Then each action appends a history entry naming its actor
    Then the reopened Decision is pending with no current outcome and keeps its place in the list
