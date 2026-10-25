Feature: The command palette opens the Catalog without a navigation entry of its own
  # Source: Discussion #241 owner rulings 2026-10-26 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19181914 (ruling 1).
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L233` "is a command-palette destination that opens it, with no navigation entry of its own". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L233
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L219` "is the target of the ?section=components#product-kit-catalog deep link". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L219
  # Status: built as of 7f53c91.
  @spec:id:01a17455-8053-7129-a362-5e2c95232e57
  @spec:demonstrates:01a116f0-8b11-7eba-96eb-786ba7098589
  @spec:demonstrates:01a17443-8e49-7ae2-905c-e13b9dcdddca
  Scenario: The command palette opens the Catalog without a navigation entry of its own
    Given A Reviewer is on the Overview
    When The Reviewer picks Catalog in the command palette
    Then The Product Kit page opens at the Catalog block of its Components section
    Then Neither the sidebar nor the Workspace sub-navigation has a Catalog entry
