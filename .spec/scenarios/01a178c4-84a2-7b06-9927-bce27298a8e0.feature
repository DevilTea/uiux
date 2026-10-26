Feature: A declared translation Property nobody evaluated is reported as unevaluated and not forced
  # Source: Discussion #241 owner rulings 2026-10-26, ruling 5 (issue #95). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@10eed57 `tests/preview-checks-observer.test.ts#L236-L253` "lists every declared Property nothing evaluated, evaluates none to say so, and drops one once it is evaluated"](https://github.com/DevilTea/uiux/blob/10eed57/tests/preview-checks-observer.test.ts#L236-L253)
  # Test: [code@10eed57 `tests/preview-checks-report.test.ts#L353-L361` "is complete when the Runtime left no declared Property unevaluated, and incomplete with the list when it did"](https://github.com/DevilTea/uiux/blob/10eed57/tests/preview-checks-report.test.ts#L353-L361)
  # Status: built as of 10eed57.
  @spec:id:01a178c4-84a2-79a1-a5b3-39d85d53c48f
  @spec:demonstrates:01a115cd-b983-7fc3-88fb-57247dd8082a
  @spec:demonstrates:01a17619-89fc-7a94-b690-2e65c6a99f39
  @spec:demonstrates:01a17619-ab3f-797d-ae93-4038a48ee31f
  @spec:demonstrates:01a178c4-7217-7478-82ee-3917c2040711
  Scenario: A declared translation Property nobody evaluated is reported as unevaluated and not forced
    Given a live Preview of a View with two Labels whose result Properties the Runtime has not evaluated
    When the Runtime evaluates the result Property of one Label
    When the Preview sends a `checks.report`
    Then the report's coverage is incomplete and lists the other Label's result Property
