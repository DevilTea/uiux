Feature: Preview failure diagnostics
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 decision 9 https://github.com/DevilTea/uiux/discussions/131#9-failure-scopes-and-their-effects-group-c; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #111.
  # Status: not built as of cf3b984; see the Implementation gaps entries of 01a11a59-eecb-7aff-983b-972148c714e1 and 01a11a59-def9-797a-8d08-5e4b02ecd900 in their owners.
  @spec:id:01a11a5b-61a6-74d4-a9a5-ae54f38cded7
  @spec:demonstrates:01a11687-375e-7667-b8f1-59389fdd9780
  @spec:demonstrates:01a11a59-def9-797a-8d08-5e4b02ecd900
  @spec:demonstrates:01a11a59-eecb-7aff-983b-972148c714e1
  Scenario: A generation-scoped runtime failure waits for Retry Preview
    Given an acknowledged runtime generation that declares failure reports
    When the runtime reports a generation-scoped `runtime.unavailable` failure
    Then the Workbench ends that generation and starts no automatic recovery generation
    Then it shows the inline Preview diagnostic with Retry Preview
