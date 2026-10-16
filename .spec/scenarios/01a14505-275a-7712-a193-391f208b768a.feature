Feature: Formal capture is refused while the default Locale has no file
  # Source: issue #94 (https://github.com/DevilTea/uiux/issues/94). Decisions behind the demonstrated Rule: #1 c30 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18573911; #1 c160 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18662530.
  # Test: code@7b3364e `tests/missing-default-locale.test.ts#L91` "refuses formal capture of every context over HTTP and MCP, and stores no Evidence". https://github.com/DevilTea/uiux/blob/7b3364ee37acc54b479d5c3e0223059d5be0718c/tests/missing-default-locale.test.ts#L91
  # Status: built as of 7b3364e.
  @spec:id:01a14505-2759-71cc-a5e4-f29394a0bdd6
  @spec:demonstrates:01a115cd-b30b-706e-b8a2-46e62259156e
  Scenario: Formal capture is refused while the default Locale has no file
    Given the Workspace default Locale has no Locale file and another Locale file exists
    When an Agent captures formal Evidence for two render contexts
    Then every context fails with the missing default-Locale diagnostic
    Then no Evidence is stored
