Feature: A Catalog problem of an entry a View uses shows once, grouped by View and Widget
  # Source: Discussion #1 comment 77 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610366, Discussion #1 comment 78 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610433, Discussion #1 comment 79 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610541 (Catalog problems of used entries, grouped problem, View, Widget).
  # Test: code@01f26de `tests/checks-sources-browser.test.ts#L91` "lists reminders and Catalog problems with their origin, scope, state and severity, errors first". https://github.com/DevilTea/uiux/blob/01f26de/tests/checks-sources-browser.test.ts#L91
  # Test: code@01f26de `tests/checks-findings.test.ts#L199` "shows one problem once, expanding to each distinct View and then each distinct Widget". https://github.com/DevilTea/uiux/blob/01f26de/tests/checks-findings.test.ts#L199
  # Status: built as of 01f26de.
  @spec:id:01a1740e-cd46-756c-84e6-9794475d91d6
  @spec:demonstrates:01a115cd-be51-740b-8472-c08dc7138e3e
  @spec:demonstrates:01a115cd-be84-755b-b9fb-62f519cf989c
  Scenario: A Catalog problem of an entry a View uses shows once, grouped by View and Widget
    Given a Catalog entry has a problem
    Given a View has two Widgets of that entry
    Given another entry has a problem and no View uses it
    When a Reviewer runs Checks
    Then Checks lists the problem once, with the View and then its two Widgets, each with a count
    Then Checks lists no problem of the unused entry
