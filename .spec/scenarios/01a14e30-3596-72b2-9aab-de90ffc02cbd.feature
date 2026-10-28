Feature: View Variants
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R7: a Variant entry is exactly `{ state }`, and unknown entry keys are rejected https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@0b36372 `tests/domain-contracts.test.ts#L120` "validates the View root boundary without taking ownership of Widget IR". https://github.com/DevilTea/uiux/blob/0b363723bcdbc41f7ff7685a9cdbed579067fd2e/tests/domain-contracts.test.ts#L120
  # Test: code@0b36372 `tests/persistence.test.ts#L402` "diagnoses a stored View whose Variant entry holds a key other than state". https://github.com/DevilTea/uiux/blob/0b363723bcdbc41f7ff7685a9cdbed579067fd2e/tests/persistence.test.ts#L402
  # Test: code@0b36372 `tests/transport-authoring.test.ts#L480` "accepts a Variant entry of exactly { state } and refuses any other entry key over MCP and HTTP". https://github.com/DevilTea/uiux/blob/0b363723bcdbc41f7ff7685a9cdbed579067fd2e/tests/transport-authoring.test.ts#L480
  # Test: code@ad0fc2e `tests/requirement-references.test.ts#L58` "requires a Spec to list `requirements` and lets a Variant entry and a Flow list them (an entry key config stays refused)". https://github.com/DevilTea/uiux/blob/ad0fc2e54bc67c53d74b3b94becbf0caeec92ee4/tests/requirement-references.test.ts#L58
  # Status: built as of ad0fc2e: an entry key other than `state` and `requirements`, such as `config`, is refused, and the optional `requirements` key that Discussion #379 admits is built (Clause 01a1144e-5423-7def-a70a-7962ad2d2af7).
  @spec:id:01a14e30-3596-71c9-aedf-4485f5fced19
  @spec:demonstrates:01a1144e-5423-7def-a70a-7962ad2d2af7
  Scenario: A Variant entry with a key other than state is refused
    Given a View whose Variant entry holds `state` and `config`
    When UIUX validates the View
    Then the View is invalid with a diagnostic at that entry's `config`
