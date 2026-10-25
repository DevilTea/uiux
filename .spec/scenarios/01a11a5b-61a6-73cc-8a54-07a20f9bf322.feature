Feature: Preview failure diagnostics
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 9 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Test: [code@ebae02e `tests/preview-failure-browser.test.ts#L457` "ends the generation for a generation-scoped runtime failure, starts no recovery, and Retry Preview recovers (Scenario 01a11a5b-61a6-74d4-a9a5-ae54f38cded7)"](https://github.com/DevilTea/uiux/blob/ebae02efd0c0eb22ed009c8373ed8f0cda05eada/tests/preview-failure-browser.test.ts#L457)
  # Status: built as of ebae02e (issue #312): the Workbench effect is exercised with a `runtime.unavailable` report injected from the Preview frame, because the runtime has no producer of such a report yet; see the Implementation gaps entry of 01a11a70-4261-7155-8aed-28bed7a89064 in its owner.
  @spec:id:01a11a5b-61a6-74d4-a9a5-ae54f38cded7
  @spec:demonstrates:01a11687-375e-7667-b8f1-59389fdd9780
  @spec:demonstrates:01a11a59-def9-797a-8d08-5e4b02ecd900
  @spec:demonstrates:01a11a59-eecb-7aff-983b-972148c714e1
  Scenario: A generation-scoped runtime failure waits for Retry Preview
    Given an acknowledged runtime generation that declares failure reports
    When the runtime reports a generation-scoped `runtime.unavailable` failure
    Then the Workbench ends that generation and starts no automatic recovery generation
    Then it shows the inline Preview diagnostic with Retry Preview
