Feature: A fresh Flow trace and the captures it references enter a Handoff as derived artifacts
  # Source: Discussion #6 comment 3 (2026-09-30), 10a https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18673622; issue #88.
  # Test: code@82de28b `tests/handoff-closure.test.ts#L1953` "references a fresh trace and its captures as derived artifacts". https://github.com/DevilTea/uiux/blob/82de28b/tests/handoff-closure.test.ts#L1953
  # Status: built as of 82de28b.
  @spec:id:01a177b3-84f9-7d27-9f54-30a9eb195192
  @spec:demonstrates:01a11544-6734-7a24-a957-e23ddeb3e396
  Scenario: A fresh Flow trace and the captures it references enter a Handoff as derived artifacts
    Given a Flow in the closure of a Handoff export and a fresh flow_trace record of it
    When the Handoff is exported
    Then the manifest references the trace and the capture it names as derived artifacts
    Then the canonical Flow stays an authored resource of the bundle
