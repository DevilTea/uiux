Feature: A late declaration from a replaced Preview document admits no generation
  # Source: PR #307 review; owner ruling 1 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19134771.
  # Test: code@31f7839 `tests/flows-browser.test.ts#L399` "never admits a late declaration of the document a fast second step entry replaced". https://github.com/DevilTea/uiux/blob/31f783925b18d99d07196b58a68b9addb4c59a43/tests/flows-browser.test.ts#L399
  # Status: built as of 31f7839.
  @spec:id:01a1660b-cd0d-776d-99cd-1ef9fb4a216c
  @spec:demonstrates:01a1660a-8cd1-7269-a76a-57e1accbe69d
  Scenario: A late declaration from a replaced Preview document admits no generation
    Given a Prototype step entry loaded a Preview document whose declaration has not reached the Workbench yet
    When the member advances to the next step entry before that declaration arrives
    When the replaced document declaration reaches the Workbench while the next document is still loading
    Then the Workbench admits no generation and sends the replaced document no acknowledgement or arm
    Then a click in the replaced document never advances the player
