Feature: Formal capture is refused while the default Locale has no file
  # Source: issue #94 (https://github.com/DevilTea/uiux/issues/94). Decisions behind the demonstrated Rule: #1 c30 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18573911; #1 c160 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18662530.
  # Test: code@7f83900 `tests/missing-default-locale.test.ts#L92` "refuses formal capture of every context over HTTP and MCP, and stores no Evidence". https://github.com/DevilTea/uiux/blob/7f83900e7b17b8838f9b31d29c560472d63aac4a/tests/missing-default-locale.test.ts#L92
  # Status: built as of 7f83900.
  @spec:id:01a14505-2759-71cc-a5e4-f29394a0bdd6
  @spec:demonstrates:01a115cd-b30b-706e-b8a2-46e62259156e
  Scenario: Formal capture is refused while the default Locale has no file
    Given the Workspace default Locale has no Locale file and another Locale file exists
    When an Agent captures formal Evidence for two render contexts
    Then every context fails with the missing default-Locale diagnostic
    Then no Evidence is stored
