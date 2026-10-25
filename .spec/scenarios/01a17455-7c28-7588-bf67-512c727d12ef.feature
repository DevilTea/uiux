Feature: The Catalog lists one read-only row per Widget type and opens its detail in place
  # Source: Discussion #241 owner rulings 2026-10-26 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19181914 (ruling 2; issue #116).
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L122` "lists one row per Widget type of the active Adapters, read-only". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L122
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L137` "opens a detail with the Config schema, declared Events, i18n mapping and Asset fields". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L137
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L253` "lists and opens entries read-only on a tablet and a phone, without scrolling the page sideways". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L253
  # Status: built as of 7f53c91.
  @spec:id:01a17455-7c28-718f-9b19-15c55caea6d2
  @spec:demonstrates:01a17443-6b37-797e-963c-282f2ec400a7
  Scenario: The Catalog lists one read-only row per Widget type and opens its detail in place
    Given Two Adapters are active and declare nine Widget types between them
    When A Reviewer opens the Components section of the Product Kit page
    Then The Catalog lists one row per Widget type, each with its Adapter and description
    Then Opening a row shows its Config schema, Properties, State, declared Events, i18n mapping and Asset fields
    Then The Catalog offers no control that edits an entry
