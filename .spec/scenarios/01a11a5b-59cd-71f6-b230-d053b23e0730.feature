Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 decision 5 https://github.com/DevilTea/uiux/discussions/131#5-region-status-carrier-group-b-106; #131 decision 7 https://github.com/DevilTea/uiux/discussions/131#7-gating-for-region-status-group-b; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #106.
  # Status: not built as of cf3b984; see the Implementation gaps entries of 01a11658-1d29-793c-9641-264dc477cfd5 and 01a11a59-dbda-79e5-9337-307bb9c1798b in their owners.
  @spec:id:01a11a5b-59cd-73a2-9dc7-8071f45f23ae
  @spec:demonstrates:01a11658-1d29-793c-9641-264dc477cfd5
  @spec:demonstrates:01a11687-3190-7ddd-afc2-6b2fb591f53d
  @spec:demonstrates:01a11a59-dbda-79e5-9337-307bb9c1798b
  Scenario: A translucently covered target shows one notice and one Checks marker
    Given a Widget lies under a translucent overlay that leaves it discernible
    Given the Preview runtime declares region-status support
    When a Reviewer opens that Widget from its View page's Checks panel
    Then the Workbench highlights the covered area of the Widget
    Then it shows one translucent-obstruction notice beside the highlight and one marker on the Widget's Checks entry
