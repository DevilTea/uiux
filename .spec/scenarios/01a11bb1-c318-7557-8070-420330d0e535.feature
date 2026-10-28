Feature: Adapter selection and resolution
  # Source: Discussion #139 (Part 14, Product Kit), decision 6, A; R8; owner pre-answer P14; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Test: code@87211f6 `tests/preview-stylesheet-browser.test.ts#L73` "renders the component library styled once its stylesheet has loaded, with its font served and the theme attributes set". https://github.com/DevilTea/uiux/blob/87211f6a63557fda5e7e37ec2e608fe0d80486b2/tests/preview-stylesheet-browser.test.ts#L73
  # Test: code@87211f6 `tests/preview-product-kit-stylesheet.test.ts#L269` "links the stylesheet after UIUX's own, renders the library styled once it has loaded, and swaps the theme attributes live". https://github.com/DevilTea/uiux/blob/87211f6a63557fda5e7e37ec2e608fe0d80486b2/tests/preview-product-kit-stylesheet.test.ts#L269
  # Test: code@87211f6 `tests/preview-product-kit-stylesheet.test.ts#L199` "builds the style entries, then the CSS the module graph imports, into one stylesheet with the font as a file". https://github.com/DevilTea/uiux/blob/87211f6a63557fda5e7e37ec2e608fe0d80486b2/tests/preview-product-kit-stylesheet.test.ts#L199
  # Test: code@79df3b8 `tests/reference-adapter-stylesheet.test.ts#L100` "builds the CSS that the kit build output imports into the Product Kit stylesheet, not into the module". https://github.com/DevilTea/uiux/blob/79df3b8e23c457dfceb89fd8eae5aa3da11601f6/tests/reference-adapter-stylesheet.test.ts#L100
  # Test: code@79df3b8 `tests/kit-dogfood.test.ts#L109` "emits the wrapper entry and one stylesheet, deterministically and with no host path in them". https://github.com/DevilTea/uiux/blob/79df3b8e23c457dfceb89fd8eae5aa3da11601f6/tests/kit-dogfood.test.ts#L109
  # Status: built as of 87211f6.
  # Note: The tests' component library is a plain JavaScript package that imports its CSS and a font; it stands in for a Vue component library a bundler built, since UIUX compiles no `.vue` file and the tests run no kit build tool.
  # Note: Since issue #380 (code@79df3b8) the dogfood Workspace's kit is a real build of Vue single file components (`.uiux/kit/build.mjs`, declared in `.uiux/kit/package.json`): the two Tests above bundle its output, the wrapper entry `dist/uiux.js` with its stylesheet `dist/uiux.css`, through the Preview bundler.
  @spec:id:01a11bb1-c318-76ba-b849-1a9050d129c9
  @spec:demonstrates:01a11bb1-acdc-799f-aed7-c85ddbaf0d28
  @spec:demonstrates:01a11bb1-ad41-761c-ad47-a0e7ed5b8240
  Scenario: A component library that imports its CSS from JavaScript renders styled
    Given a kit whose wrapper entry uses a Vue component library that imports its CSS from JavaScript
    When a View that uses a component of that library opens in the Preview
    Then the component renders with the library's styles from the Product Kit stylesheet
