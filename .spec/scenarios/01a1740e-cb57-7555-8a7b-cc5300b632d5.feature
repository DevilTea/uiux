Feature: A translation reminder in Checks opens its cell in the translation table
  # Source: Discussion #1 comment 73 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18609814 (reminders in Checks, opening the translation-table cell).
  # Test: code@01f26de `tests/checks-sources-browser.test.ts#L139` "opens the translation-table cell of a reminder". https://github.com/DevilTea/uiux/blob/01f26de/tests/checks-sources-browser.test.ts#L139
  # Test: code@01f26de `tests/checks-findings.test.ts#L157` "lists each empty and whitespace-only value by Locale, key and type, as a warning on its Locale". https://github.com/DevilTea/uiux/blob/01f26de/tests/checks-findings.test.ts#L157
  # Status: built as of 01f26de.
  @spec:id:01a1740e-cb56-7c1c-9352-1d7c10427fe8
  @spec:demonstrates:01a115cd-bd7d-705f-be59-b24cc4bd389e
  @spec:demonstrates:01a115cd-bdb2-7de2-abb9-54f592539471
  Scenario: A translation reminder in Checks opens its cell in the translation table
    Given a Locale file has an empty value for a key
    Given a Reviewer has run Checks
    When the Reviewer selects the reminder Checks lists for that Locale and key
    Then the translation table opens with that Locale's cell for the key focused
