Feature: Preview cross-iframe protocol
  # Source: [#241 proposal for #484 and owner ruling 2026-11-03 (question tool, recorded by Claude on the owner's behalf): accepted](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19364969); issue #484 https://github.com/DevilTea/uiux/issues/484.
  # Test: code@15422db `tests/inspector-base-state-browser.test.ts#L101` "shows the base value when a Spec edit lands between the Preview document's read of the View and the Workbench's own (issue #484)". https://github.com/DevilTea/uiux/blob/15422db4836893d79fcb1691a7b87e2ab1ce8caa/tests/inspector-base-state-browser.test.ts#L101
  # Test: code@15422db `tests/base-state-requests.test.ts#L514` "compares a response with the revision the Preview reported, not with any revision the Workbench read itself". https://github.com/DevilTea/uiux/blob/15422db4836893d79fcb1691a7b87e2ab1ce8caa/tests/base-state-requests.test.ts#L514
  # Test: code@15422db `tests/preview-base-state-runtime.test.ts#L793` "reports the revision of the first render, and holds a render that completed before the ACK until it arrives". https://github.com/DevilTea/uiux/blob/15422db4836893d79fcb1691a7b87e2ab1ce8caa/tests/preview-base-state-runtime.test.ts#L793
  # Status: Built as of 15422db.
  @spec:id:01a19f55-b709-76d5-b2e1-a309342f6cb1
  @spec:demonstrates:01a19ab9-d028-7bb9-a370-4736992852f5
  @spec:demonstrates:01a19f53-cc4a-7e9f-8458-7544564f5c70
  Scenario: The Preview reports the View revision it mounted, so a Spec edit during load does not leave the Base cell Unavailable
    Given a Workbench Preview generation that declared `inspection.base-state` and acknowledged, whose Preview has not yet read the View
    Given the open Variant overrides the State member `disabled` of a Button, and the selected Widget is that Button
    When a Spec edit changes the View's revision before the Preview reads the View, and the Preview mounts the edited View
    Then the Preview sends `inspection.base-state.mounted` with the revision of the edited View
    Then the Workbench asks for `disabled` and compares the response with that revision, so the Base cell of `disabled` reads its base value, not Unavailable
