Feature: Translation runtime
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 c23 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18564804; #1 c28 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18568126; #1 c42 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18579024; #1 c162 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18669256; and 2 more in their owners' Rule sources.
  # Test: code@a021f9e `tests/i18n-assets.test.ts#L26` "distinguishes missing translation fallback, unresolved keys, and missing parameters in canonical warning order". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/i18n-assets.test.ts#L26
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d920-7a7e-bb19-34078f1935d3
  @spec:demonstrates:01a115cd-b6ff-79de-8d98-dcbd0c07c504
  @spec:demonstrates:01a115cd-b732-79db-b872-ac27713f15f8
  @spec:demonstrates:01a115cd-d41a-7a30-b9f4-32d981239a29
  Scenario: A key missing from the requested Locale falls back with a warning
    Given the default Locale has a key that the requested Locale lacks
    When a Widget translates that key in the requested Locale
    Then it renders the default Locale's text as a successful result
    Then the result carries a `missing-translation` warning
