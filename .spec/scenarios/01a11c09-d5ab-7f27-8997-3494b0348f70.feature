Feature: Access and roster
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 1, A: rationale (the Translator preset example); decision 2, A; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 47a571a.
  # Test: code@98672a4 `tests/access-policy.test.ts#L424` "lets a translator update a Locale but refuses a View Spec, naming views.write (Scenario 01a11c09-d5ab)". https://github.com/DevilTea/uiux/blob/98672a48d3d0babd56b8d471322cb3eea13f0d7f/tests/access-policy.test.ts#L424
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L359` "resolves exactly the stored catalog keys for a human member, with a role derived from them". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L359
  @spec:id:01a11c09-d5ab-78df-a49a-58e3c3151c5e
  @spec:demonstrates:01a11485-eaac-7523-998b-26123d7618df
  @spec:demonstrates:01a11485-f9bd-78a3-a1d0-1b4f64e9883e
  @spec:demonstrates:01a11485-fa44-7b6a-99f8-de4e1e8edcfc
  Scenario: A translator edits a Locale but not a View
    Given a member holding only `workspace.read`, `reviews.write` and `locales.write`
    When the member updates a Locale and then a View's Spec
    Then the Locale is updated
    Then the View update is refused with `auth.scope_denied` whose `requiredKeys` is `views.write`
