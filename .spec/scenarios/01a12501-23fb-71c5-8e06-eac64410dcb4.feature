Feature: Access and roster
  # Source: Discussion #174 (Part 16), Decisions: roster administration only from loopback and `https` origins; Security rationale: Administration; New Scenarios https://github.com/DevilTea/uiux/discussions/174; accepted as written 2026-10-10 https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848606.
  # Status: not built as of b9b9e71; see the Implementation gaps entries of 01a12500-b105-7773-822f-359d4dcbd1da and 01a12500-a619-7fa5-b7f6-797adaf52f34 in their owners.
  # Note: No test exists yet; tracked in issue #176.
  @spec:id:01a12501-23fa-7f44-9470-62d9f6fb8ab2
  @spec:demonstrates:01a12500-a619-7fa5-b7f6-797adaf52f34
  @spec:demonstrates:01a12500-b105-7773-822f-359d4dcbd1da
  Scenario: Administration is refused on an `http` configured origin
    Given `uiux dev` runs with the configured origin `http://10.0.0.5:3000`
    Given a human member holding `members.manage` is signed in on that origin
    When the member creates a Token on that origin
    Then the request is refused with HTTP 403 `access.admin_origin_rejected`
    Then no Token is created
