Feature: Adapter Catalog and Widget integration
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R8: derived names are still validated strictly at load time https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A3 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #54 https://github.com/DevilTea/uiux/issues/54.
  # Test: code@893ec92 `tests/view-runtime.test.ts#L494` "validates a derived Property name as a declared one, and a declared name overrides the derivation" (the derived `title` is missing; a derived name with the wrong value contract is refused too). https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/view-runtime.test.ts#L494
  # Note: the check against the Widget plugin runs in `materializeRuntimeAdapterBundle` (`src/runtime/adapter-runtime.ts`), which the tests call; at 893ec92 neither the Preview nor the server calls it.
  # Status: partly built as of 893ec92 — enforced by the runtime check in tests only; production load does not run it (#255).
  @spec:id:01a14fdd-5069-7412-a31d-05d8e26ec25a
  @spec:demonstrates:01a14e30-3676-7212-8cee-1ef84da6316c
  Scenario: A derived Property name the Widget plugin does not declare is refused at load
    Given an Adapter whose Widget plugin `LocalizedLabel` declares the string Config member `titleKey`, a TranslationResult Property `titleResult` and a string Property `label`, but no Property `title`
    Given its Catalog maps the authoring field `title` as `{ "configField": "titleKey" }`
    When the Adapter is loaded
    Then the load is refused with one diagnostic at the mapping's `textProperty`, naming the derived Property `title` as not declared by the Widget plugin
