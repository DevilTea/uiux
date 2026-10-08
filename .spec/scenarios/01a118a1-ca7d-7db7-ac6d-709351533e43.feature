Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d7, D14 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #7 c8 item 7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18758345. Restated as permission keys by Discussion #140 (Part 15), What `humanOnly` means; R4; owner answer Q5 https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Test: code@a021f9e `tests/access-http.test.ts#L203` "refuses bearer tokens on resolve and on Owner administration". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-http.test.ts#L203
  # Test: code@a021f9e `tests/access-policy.test.ts#L209` "refuses bearer tokens with review.resolve_requires_workbench and agent sessions with review.resolve_requires_human". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-policy.test.ts#L209
  # Status: partly built as of 0c26ead: the bearer refusal is built, and members hold roles, not keys; see the Implementation gaps entries of 01a11485-fa87-7cf8-8ec1-275793457228 and 01a11c09-bec8-7dee-971a-4c10eaf83eef in their owners.
  @spec:id:01a118a1-ca7d-77a4-9375-125dcfa67cd2
  @spec:demonstrates:01a11485-fa87-7cf8-8ec1-275793457228
  @spec:demonstrates:01a11c09-bec8-7dee-971a-4c10eaf83eef
  Scenario: A bearer Token cannot resolve a thread over HTTP
    Given a thread ready for review
    Given the member Token of a human member holding `reviews.resolve`
    When the Token is sent as a bearer credential to the resolve route
    Then the request is refused with `review.resolve_requires_workbench`
