Feature: Adapter Catalog and Widget integration
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R8: a mapping may omit `textProperty` and `resultProperty`, derived by a fixed convention and validated strictly at load time https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A3, `<authorField>` and `<authorField>Result` https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #54 https://github.com/DevilTea/uiux/issues/54.
  # Test: code@893ec92 `tests/view-runtime.test.ts#L474` "validates and renders a mapping that omits both Property names through the derived <field>Result and <field> Properties". https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/view-runtime.test.ts#L474
  # Test: code@893ec92 `tests/reference-adapter.test.ts#L68` "omits every i18n Property name, and each derived name passes the strict check against its Widget plugin" (the reference Adapter). https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/reference-adapter.test.ts#L68
  # Test: code@893ec92 `tests/i18n-assets.test.ts#L138` "derives an omitted textProperty as the authoring field and an omitted resultProperty as <field>Result, and keeps a declared name (Clause 01a14e30-3676)" (the lowered binding carries the derived names). https://github.com/DevilTea/uiux/blob/893ec92cb1cb8cc989d9ed5b0be09bee23fdf50d/tests/i18n-assets.test.ts#L138
  # Note: the check against the Widget plugin runs in `materializeRuntimeAdapterBundle` (`src/runtime/adapter-runtime.ts`), which the tests call; at 893ec92 neither the Preview nor the server calls it, so only the manifest check (shape and name collisions) runs there.
  # Status: partly built as of 893ec92 — enforced by the runtime check in tests only; production load does not run it (#255).
  @spec:id:01a14fdd-327e-7fab-8f9a-0443530c1b4d
  @spec:demonstrates:01a115cd-d1ec-7ceb-9e0f-292719127bf4
  @spec:demonstrates:01a14e30-3676-7212-8cee-1ef84da6316c
  Scenario: An i18n mapping that omits its Property names renders through the derived Properties
    Given an Adapter whose Widget plugin `ConventionLabel` declares the string Config member `titleKey`, a TranslationResult Property `titleResult` and a string Property `title`
    Given its Catalog maps the authoring field `title` as `{ "configField": "titleKey" }`, with no `resultProperty` or `textProperty`
    Given a View whose `ConventionLabel` Widget authors `title` as `{ "$i18n": "countTitle" }`
    When the Adapter is loaded and the View is rendered in `en-US`
    Then the load-time Catalog check passes
    Then the Widget's `titleResult` Property holds the `en-US` translation of `countTitle` and its `title` Property that translation's text
