Feature: Adapter Catalog and Widget integration
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R8: the unique, non-conflicting names Clause applies to derived names https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A3 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #54 https://github.com/DevilTea/uiux/issues/54.
  # Test: code@893ec92 `tests/i18n-assets.test.ts#L170` "checks derived Property names for collisions exactly as declared ones (Clause 01a115cd-d25b)" (also a derived name against another field's derived or declared name). https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/i18n-assets.test.ts#L170
  # Status: built as of 893ec92.
  @spec:id:01a14fdd-87be-79e0-ad87-96b3ec4a8127
  @spec:demonstrates:01a115cd-d25b-7bf4-901d-bceceddfa11d
  @spec:demonstrates:01a14e30-3676-7212-8cee-1ef84da6316c
  Scenario: A derived Property name that conflicts with another mapping name is refused
    Given an Adapter Catalog that maps the authoring field `title` of a Widget type as `{ "configField": "title" }`
    When UIUX validates the Adapter manifest
    Then the manifest is refused with one diagnostic at the mapping's `textProperty`, because the derived text Property `title` conflicts with the `configField` `title`
