Feature: Product Kit
  # Source: Discussion #139 (Part 14, Product Kit), decision 9, A; R11; owner pre-answers P18, P23; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 2f7e092; see the Implementation gaps entry of 01a11bb1-a376-719c-86e0-5f5e4d11cb8c in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c118-79ab-bc18-bcdfc259021b
  @spec:demonstrates:01a11bb1-8bd0-72ce-83e5-b251bf855e0f
  @spec:demonstrates:01a11bb1-a376-719c-86e0-5f5e4d11cb8c
  @spec:demonstrates:01a11bb1-a3de-7426-94d2-c0e2bdd0be72
  Scenario: Copying a component writes its files and the project copy record
    Given a product project with a `package.json` and a Workspace whose registry has a `button` component
    When a developer runs `uiux components add button --to src/ui` in the product project
    Then the files of `button` are written under `src/ui/`
    Then the project root's `uiux-components.json` records `button` with the target `src/ui` and a digest for each file
