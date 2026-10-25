Feature: A translation Property that cannot be evaluated makes the capture incomplete
  # Source: [#241 owner rulings 2026-10-25 (issue #96)](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19175213) and the Rules and Clauses demonstrated.
  # Test: code@67e4111 `tests/formal-capture.test.ts#L838` "records incomplete coverage with the missing Property when an Adapter t throws, and keeps the other entries". https://github.com/DevilTea/uiux/blob/67e41119231335c327f4ca39af248ed61b989224/tests/formal-capture.test.ts#L838
  # Test: code@67e4111 `tests/translation-evaluation.test.ts#L164` "lists a Property whose evaluation throws or returns another shape as missing, and keeps the others". https://github.com/DevilTea/uiux/blob/67e41119231335c327f4ca39af248ed61b989224/tests/translation-evaluation.test.ts#L164
  # Test: code@67e4111 `tests/translation-evaluation.test.ts#L174` "lists a Widget or a result Property absent at runtime as missing". https://github.com/DevilTea/uiux/blob/67e41119231335c327f4ca39af248ed61b989224/tests/translation-evaluation.test.ts#L174
  # Status: built as of 67e4111.
  @spec:id:01a1724a-de6c-777d-97e4-be3492b9690e
  @spec:demonstrates:01a115cd-ba9b-70ba-a6ff-cf4649236a2c
  @spec:demonstrates:01a17245-062a-7971-b541-6780119bbcfa
  @spec:demonstrates:01a17245-06ad-70f3-88ac-9b44e9c7ba0d
  Scenario: A translation Property that cannot be evaluated makes the capture incomplete
    Given a View with a Widget whose result Property fails when evaluated and a Widget whose Property evaluates
    When formal capture is requested for that View
    Then the record lists an entry only for the Property that evaluated
    Then the record's coverage is incomplete and names the failing Property with a short reason
    Then the record does not satisfy a submission
