Feature: Adapter selection and resolution
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R4: one shared server-side check decides whether an Adapter's Widget plugins come from the host's `@deviltea/widget-core`, used by the Product Kit page, the Preview's Adapter check and the Preview https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; issue #123 https://github.com/DevilTea/uiux/issues/123.
  # Test: code@5f6de3f `tests/preview-adapter-materialization.test.ts#L764` "refuses, on the server and in the Preview alike, a Widget plugin from an Adapter that bundles its own widget-core copy (#123)". https://github.com/DevilTea/uiux/blob/5f6de3f514f069909602e2bb5f287944dc7d718d/tests/preview-adapter-materialization.test.ts#L764
  # Test: code@5f6de3f `tests/workbench-product-kit-browser.test.ts#L230` "shows the Adapter failed on its own row with the server diagnostic, as the Preview's Adapter check reports it". https://github.com/DevilTea/uiux/blob/5f6de3f514f069909602e2bb5f287944dc7d718d/tests/workbench-product-kit-browser.test.ts#L230
  # Test: code@5f6de3f `tests/preview-adapter-materialization.test.ts#L809` "reports an Adapter that imports the host widget-core valid on every server surface (#123)" (the counter-case: an Adapter that imports the host's copy passes). https://github.com/DevilTea/uiux/blob/5f6de3f514f069909602e2bb5f287944dc7d718d/tests/preview-adapter-materialization.test.ts#L809
  # Status: built as of 5f6de3f.
  # Note: The tests' Adapter is built with esbuild with widget-core inlined, so its plugins come from a real second widget-core module instance, as in a pre-built Adapter package that bundles widget-core.
  @spec:id:01a14f0c-7213-7d0a-8390-b5e19e355080
  @spec:demonstrates:01a115cd-aeca-70ba-9b35-27de544863e5
  @spec:demonstrates:01a115cd-af57-781e-9493-89d037e41b06
  @spec:demonstrates:01a116f0-cae2-7c64-9c76-d472f252789a
  Scenario: An Adapter that bundles its own widget-core copy is invalid on every surface
    Given a Workspace whose Adapter module bundles its own copy of `@deviltea/widget-core`
    When UIUX resolves the Adapter set
    Then the Adapter is invalid with a diagnostic on its Widget plugin
    Then the Product Kit page shows that diagnostic on the Adapter's row
    Then the Preview loads none of the Adapter's Widget plugins
