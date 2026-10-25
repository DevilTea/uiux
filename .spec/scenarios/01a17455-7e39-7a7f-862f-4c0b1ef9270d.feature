Feature: A Catalog entry names the Views that use it, and shows the problems of an entry no View uses
  # Source: Discussion #241 owner rulings 2026-10-26 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19181914 (ruling 2: the detail panel is the "Catalog management" of Rule 01a115cd-be51-740b-8472-c08dc7138e3e).
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L165` "names the Views that use an entry, and says so when none does". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L165
  # Test: code@7f53c91 `tests/component-catalog-browser.test.ts#L195` "shows a Catalog problem of an entry no View uses, which Checks does not list". https://github.com/DevilTea/uiux/blob/7f53c91/tests/component-catalog-browser.test.ts#L195
  # Status: built as of 7f53c91.
  @spec:id:01a17455-7e39-7c27-b7e9-57e0fc036667
  @spec:demonstrates:01a115cd-be51-740b-8472-c08dc7138e3e
  @spec:demonstrates:01a17443-7bab-7b39-9c40-97216f67b582
  Scenario: A Catalog entry names the Views that use it, and shows the problems of an entry no View uses
    Given A View has Widgets of one Catalog entry
    Given Another entry has a problem and no View uses it
    When A Reviewer opens each entry in the Catalog
    Then The first entry lists that View with its Widget count
    Then The second entry lists its problem and says Checks does not list it
