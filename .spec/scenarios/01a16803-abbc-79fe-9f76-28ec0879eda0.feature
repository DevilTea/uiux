Feature: A version frame renders an Asset as the version records it
  # Source: Discussion #241 owner rulings 2026-10-23 (#97 `$asset` bindings in Views) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141965, ruling 2.
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L263` "renders an SVG Asset in a version frame from the version blob". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L263
  # Test: code@24d7784 `tests/asset-bindings-version.test.ts#L56` "resolves each bound Asset to the content the version records, served as its version blob". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-version.test.ts#L56
  # Status: built as of 24d7784.
  @spec:id:01a16803-abbb-73f7-9dcf-25ee3f52ccf3
  @spec:demonstrates:01a167f4-401d-7330-ac65-0a900adbccd6
  Scenario: A version frame renders an Asset as the version records it
    Given an Asset whose content was replaced after a Checkpoint
    When a version frame of the Checkpoint resolves the Asset bindings of its View
    Then the Asset's URL is the version blob of the content the Checkpoint recorded
