Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decisions 3 and 4, R15, R16, R19 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5a-4d38-7f2c-98be-755d8c404d98 in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-18d2-736c-8663-3e612026f24b
  @spec:demonstrates:01a11a5a-440a-76e8-ac5f-bdea102b17ec
  @spec:demonstrates:01a11a5a-4d38-7f2c-98be-755d8c404d98
  @spec:demonstrates:01a11a5a-4dbe-79e9-808e-6128ab510097
  Scenario: Design tokens are inserted before styles across Adapters in list order
    Given a Workspace that selects a base Adapter and then an extension Adapter, each with one design-token entry and one style entry
    When a Preview Runtime is constructed
    Then the Preview document's head holds, after UIUX's own stylesheets, the base tokens, the extension tokens, the base styles and the extension styles in that order
    Then each of those style elements names its Adapter and member
