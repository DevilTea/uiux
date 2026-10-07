Feature: Translation runtime
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 c41 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18575660; #1 c64 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18608140; #1 c52 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18595393; #1 c62 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18608111; and 1 more in their owners' Rule sources.
  # Test: code@a021f9e `tests/i18n-assets.test.ts#L86` "orders distinct missing-parameter warnings by first template occurrence while substituting every occurrence". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/i18n-assets.test.ts#L86
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d9be-7778-b52f-2a92ec1894d7
  @spec:demonstrates:01a115cd-b7c5-7559-aac7-dbf746a828a0
  @spec:demonstrates:01a115cd-d55e-73e0-bafb-c2f74d2ea95a
  Scenario: Missing parameters are marked and warned in order of first use
    Given a message that interpolates two parameters
    When it is translated without either argument
    Then each placeholder renders the missing-parameter marker
    Then the result has one `missing-parameter` warning per parameter, in order of first use
