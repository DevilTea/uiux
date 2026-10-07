Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d4: baseline gates stay https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #1 c176 baseline F2, F3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820.
  # Test: code@a021f9e `tests/loopback-guard.test.ts#L217` "blocks cross-origin, cross-site and non-JSON /api mutations without touching the Workspace". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/loopback-guard.test.ts#L217
  # Test: code@a021f9e `tests/loopback-guard.test.ts#L91` "blocks cross-origin mutations, including other loopback origins and opaque origins". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/loopback-guard.test.ts#L91
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d1c0-7a3d-a1a4-0da7053995e3
  @spec:demonstrates:01a11485-edb2-77bb-9dc8-730c02deefb0
  @spec:demonstrates:01a11485-ee00-76be-b967-5a2f1c1661b2
  @spec:demonstrates:01a11485-f9df-73d4-9f47-85c9d559360c
  Scenario: A cross-origin mutation is refused before any handler runs
    Given a running `uiux dev` server
    When a page from another origin sends a state-changing request to `/api`
    Then the request is refused with HTTP 403 `request.origin_rejected`
    Then the Workspace is untouched
