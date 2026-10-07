Feature: Agent authoring over MCP
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d11 rule 2; D15 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #7 c8 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18758345.
  # Test: code@a021f9e `tests/access-leases.test.ts#L123` "locks a View for other writers with 423 resource.locked, complements CAS, and yields to an Owner force-release". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-leases.test.ts#L123
  # Test: code@a021f9e `tests/access-http.test.ts#L188` "maps the agent lease to 423 for a human write and lets the Owner force-release it over HTTP". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-http.test.ts#L188
  # Status: built as of a021f9e.
  @spec:id:01a118a1-ce37-7ca1-9313-deb0f3573829
  @spec:demonstrates:01a11485-f005-7f10-baf7-58cb17e5d0e1
  @spec:demonstrates:01a11485-f020-74e0-b721-b4d6a5d15195
  @spec:demonstrates:01a11485-f5d4-7950-b476-b471d961f332
  Scenario: An Agent's write leases the resource against other writers
    Given an Agent updated a View without acquiring a lease first
    When a human Editor saves a change to that View before the lease expires
    Then the save is refused as `locked`, naming the Agent and the lease's expiry
    Then the View is unchanged
