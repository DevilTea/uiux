Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 3 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Status: built as of a5f586e (issue #105, https://github.com/DevilTea/uiux/pull/362).
  # Test: code@a5f586e `tests/preview-reveal-browser.test.ts#L143` "visibility hidden" (a case of the table at L134-L140, which also has `display: none`, zero opacity, no rendered box and a fixed box). https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/preview-reveal-browser.test.ts#L143
  # Note: The test runs the runtime's reveal in a plain document; no test follows a hidden Widget from Checks to the Workbench.
  @spec:id:01a11a5b-551e-73f3-8393-a83fb44d7c08
  @spec:demonstrates:01a11a59-da48-7437-bee8-67787175cbda
  Scenario: A hidden navigation target never scrolls the Preview
    Given a Widget hidden by `visibility: hidden` lies below the visible part of the Preview
    Given the Preview runtime declares reveal support
    When a Reviewer opens that Widget from Checks
    Then the Preview does not scroll
