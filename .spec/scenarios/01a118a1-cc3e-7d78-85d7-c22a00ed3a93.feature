Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c6 d6, R8 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815; #7 c10 G2, G3: the Review file records no promotion https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501; #7 c9 F5 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #1 body: Workflows, Reviews, & Decisions: promoted decisions initialize in pending unless settled https://github.com/DevilTea/uiux/discussions/1.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L1066` "promotes review to decision atomically, updating target View with Decision provenance and returning Review and View URIs, and handles idempotency". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L1066
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cc3e-7f91-9034-5d4857c286a5
  @spec:demonstrates:01a11544-5fe0-76ac-a2ad-ae86e40c72b5
  @spec:demonstrates:01a11544-60bb-7018-8c81-82c17e5b80ed
  Scenario: Promoting a thread adds a Decision to its View
    Given an open thread anchored to a View
    When a Reviewer promotes the thread to a Decision with an outcome and the current revisions of the thread and the View
    Then the View's Spec gains one decided Decision that records the thread as its source
    Then the thread itself is unchanged
