Feature: The chosen layout of the Views tab is remembered in this browser only
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Test: code@a2b2a01 `tests/view-thumbnails-browser.test.ts#L51` "opens in the list, offers a grid of the same Views, and remembers the choice in this browser only". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/view-thumbnails-browser.test.ts#L51
  # Test: code@a2b2a01 `tests/view-thumbnails-browser.test.ts#L85` "opens in the list and still toggles when the browser keeps no choice". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/view-thumbnails-browser.test.ts#L85
  # Status: built as of a2b2a01.
  @spec:id:01a19b99-e37d-7c6a-bd74-0ebd53ff635f
  @spec:demonstrates:01a19b99-daf6-780f-a2ae-c96a4e27d37a
  @spec:demonstrates:01a19b99-db8e-7df7-b97e-5903af08a78b
  Scenario: The chosen layout of the Views tab is remembered in this browser only
    Given a member who has opened Overview's Views tab, which showed the list layout
    When the member chooses the grid layout and reloads the Workbench in the same browser
    Then the Views tab opens in the grid layout
    Then the same member in another browser still opens the Views tab in the list layout
