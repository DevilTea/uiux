Feature: Adapter Catalog and Widget integration
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R8: derived names are still validated strictly at load time https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A3 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #54 https://github.com/DevilTea/uiux/issues/54.
  # Test: code@893ec92 `tests/view-runtime.test.ts#L494` "validates a derived Property name as a declared one, and a declared name overrides the derivation" (the derived `title` is missing; a derived name with the wrong value contract is refused too). https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/view-runtime.test.ts#L494
  # Test: code@0f025ad `tests/preview-adapter-materialization.test.ts#L893` "refuses, on the server and in the Preview alike, a Catalog i18n mapping that names a Property the Widget plugin does not declare (#255)" (the derived text Property `subtitle`; refused by the server's check of the Preview bundle, `GET /api/preview/adapters` and the Preview mount). https://github.com/DevilTea/uiux/blob/0f025ad4b8672c89f60a9b43cc37def1da2472f2/tests/preview-adapter-materialization.test.ts#L893
  # Note: as of 0f025ad the check against the Widget plugin runs where the Preview mounts Adapters, and the server reads its findings back from the Preview bundle (issue #255).
  # Status: built as of 0f025ad.
  @spec:id:01a14fdd-5069-7412-a31d-05d8e26ec25a
  @spec:demonstrates:01a14e30-3676-7212-8cee-1ef84da6316c
  Scenario: A derived Property name the Widget plugin does not declare is refused at load
    Given an Adapter whose Widget plugin `LocalizedLabel` declares the string Config member `titleKey`, a TranslationResult Property `titleResult` and a string Property `label`, but no Property `title`
    Given its Catalog maps the authoring field `title` as `{ "configField": "titleKey" }`
    When the Adapter is loaded
    Then the load is refused with one diagnostic at the mapping's `textProperty`, naming the derived Property `title` as not declared by the Widget plugin
