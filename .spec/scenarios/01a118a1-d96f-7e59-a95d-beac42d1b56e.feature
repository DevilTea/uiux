Feature: Translation runtime
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 c29 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18568187; #1 c65 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18608155; #1 c64 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18608140.
  # Test: code@a021f9e `tests/i18n-assets.test.ts#L26` "distinguishes missing translation fallback, unresolved keys, and missing parameters in canonical warning order". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/i18n-assets.test.ts#L26
  # Test: code@a021f9e `tests/i18n-assets.test.ts#L49` "renders unresolved keys containing placeholder-like braces verbatim without parameter warnings". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/i18n-assets.test.ts#L49
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d96f-782e-91eb-8c0b3dd9b25c
  @spec:demonstrates:01a115cd-b763-7fd6-b1df-0b7b568c1879
  @spec:demonstrates:01a115cd-d462-740a-b216-5f874cec41b4
  Scenario: A key that no Locale has renders the unresolved-key marker
    Given a key that neither the requested nor the default Locale has
    When a Widget translates it
    Then it renders `⟦missing:<key>⟧`, never an empty string or the raw key
    Then the result carries an `unresolved-key` warning
