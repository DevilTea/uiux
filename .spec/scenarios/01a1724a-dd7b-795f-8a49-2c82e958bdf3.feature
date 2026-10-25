Feature: Formal capture records every declared translation Property, warnings included
  # Source: [#241 owner rulings 2026-10-25 (issue #96)](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19175213) and the Rules and Clauses demonstrated.
  # Test: code@67e4111 `tests/formal-capture.test.ts#L783` "evaluates every declared Property of a View, a hidden Widget and warnings included, in en-US and zh-TW". https://github.com/DevilTea/uiux/blob/67e41119231335c327f4ca39af248ed61b989224/tests/formal-capture.test.ts#L783
  # Test: code@67e4111 `tests/translation-evaluation.test.ts#L140` "records one entry per Property in Widget order, including one with no warnings, in en-US". https://github.com/DevilTea/uiux/blob/67e41119231335c327f4ca39af248ed61b989224/tests/translation-evaluation.test.ts#L140
  # Test: code@67e4111 `tests/translation-evaluation.test.ts#L150` "records the fallback warning for a key a Locale lacks, in zh-TW, and carries the Variant name". https://github.com/DevilTea/uiux/blob/67e41119231335c327f4ca39af248ed61b989224/tests/translation-evaluation.test.ts#L150
  # Status: built as of 67e4111.
  @spec:id:01a1724a-dd7a-7e41-b530-9e7db6a02a80
  @spec:demonstrates:01a115cd-ba68-7c73-a157-08ef34be1e54
  @spec:demonstrates:01a115cd-cf78-7bfa-b606-b196496d0389
  @spec:demonstrates:01a115cd-cfb1-7b51-8730-6418d218eb51
  @spec:demonstrates:01a17245-0499-7f66-beea-fcc300b5d6b5
  @spec:demonstrates:01a17245-0527-7911-adbe-7af2e8962e18
  @spec:demonstrates:01a17245-05a6-7541-8d2a-0f30f310919b
  @spec:demonstrates:01a17245-0819-758a-b185-d9633fec7262
  Scenario: Formal capture records every declared translation Property, warnings included
    Given a View with a visible Widget and a hidden Widget whose Catalog maps a field to a translation-result Property
    Given a Locale file that lacks one of the keys the Widgets use
    When formal capture is requested for that View in that Locale
    Then the record lists one translation entry for each declared Property, the hidden Widget's and the warning-free ones included, in the ordering of the Contract
    Then the entry of the missing key carries its `missing-translation` warning and the fallback text
    Then the record states complete translation coverage and still satisfies a submission
