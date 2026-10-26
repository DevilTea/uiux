Feature: The affected Views and Widgets of a Catalog problem follow View edits without a new run
  # Source: Discussion #1 comment 78 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610433, Discussion #1 comment 79 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610541 (the affected Views and Widgets follow current Workspace usage without revalidating the Catalog).
  # Test: code@7e8b553 `tests/checks-catalog-live-browser.test.ts#L67` "recounts the affected Widgets and drops the problem when no View uses its entry, without asking for the Adapter report again". https://github.com/DevilTea/uiux/blob/7e8b553/tests/checks-catalog-live-browser.test.ts#L67
  # Status: built as of 7e8b553.
  @spec:id:01a177ae-61c0-7eb5-8eb6-c693816b378e
  @spec:demonstrates:01a115cd-beb7-7024-9e44-0b5fe9ecf9af
  Scenario: The affected Views and Widgets of a Catalog problem follow View edits without a new run
    Given Checks has run and lists a Catalog problem with a View and its three Widgets of that entry
    When an Agent edits the View so that it has two Widgets of that entry
    Then Checks lists the problem with the View and its two Widgets without another run
    Then Checks does not ask for the Catalog's problems again
