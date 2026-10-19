Feature: Adapter Catalog and Widget integration
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R8: a mapping may omit `textProperty` and `resultProperty` https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A3 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #54 https://github.com/DevilTea/uiux/issues/54.
  # Test: code@893ec92 `tests/view-runtime.test.ts#L494` "validates a derived Property name as a declared one, and a declared name overrides the derivation". https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/view-runtime.test.ts#L494
  # Test: code@893ec92 `tests/i18n-assets.test.ts#L138` "derives an omitted textProperty as the authoring field and an omitted resultProperty as <field>Result, and keeps a declared name (Clause 01a14e30-3676)". https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/i18n-assets.test.ts#L138
  # Test: code@0f025ad `tests/preview-adapter-materialization.test.ts#L929` "accepts, on every surface, a Catalog i18n mapping that declares Property names that override the derivation and matches the Widget plugin (#255)" (both names declared over the undeclared derived `heading` and `headingResult`). https://github.com/DevilTea/uiux/blob/0f025ad4b8672c89f60a9b43cc37def1da2472f2/tests/preview-adapter-materialization.test.ts#L929
  # Note: as of 0f025ad the check against the Widget plugin runs where the Preview mounts Adapters, and the server reads its findings back from the Preview bundle (issue #255).
  # Status: built as of 0f025ad.
  @spec:id:01a14fdd-6af7-7018-b852-146d6718c00c
  @spec:demonstrates:01a14e30-3676-7212-8cee-1ef84da6316c
  Scenario: A declared Property name overrides the derivation
    Given an Adapter whose Widget plugin `LocalizedLabel` declares the string Config member `titleKey`, a TranslationResult Property `titleResult` and a string Property `label`, but no Property `title`
    Given its Catalog maps the authoring field `title` as `{ "configField": "titleKey", "textProperty": "label" }`
    When the Adapter is loaded
    Then the load-time Catalog check passes, with `label` as the field's text Property and the derived `titleResult` as its result Property
