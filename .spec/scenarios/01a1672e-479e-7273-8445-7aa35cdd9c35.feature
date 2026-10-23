Feature: Switching View clears the inline Preview diagnostic until the new document is refused
  # Source: issue #111 (https://github.com/DevilTea/uiux/issues/111); owner ruling 4 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19138451. Decisions behind the demonstrated Rules: #2 c15 d1 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654094; #1 c142 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651379.
  # Test: code@1b1b64c `tests/preview-failure-browser.test.ts#L274` "clears the diagnostic when another View replaces the context, and shows it again for a refused document". https://github.com/DevilTea/uiux/blob/1b1b64c95211a1aaee8ca0c5433f311e4f9f2624/tests/preview-failure-browser.test.ts#L274
  # Test: code@1b1b64c `tests/preview-failure-diagnostic.test.ts#L78` "shows the failure that exhausted recovery again under a refused generation". https://github.com/DevilTea/uiux/blob/1b1b64c95211a1aaee8ca0c5433f311e4f9f2624/tests/preview-failure-diagnostic.test.ts#L78
  # Status: built as of 1b1b64c for the failures the Workbench derives; see the Implementation gaps entry of 01a11687-375e-7667-b8f1-59389fdd9780 in its owner.
  @spec:id:01a1672e-479e-7069-b03e-74300707be99
  @spec:demonstrates:01a1161c-3e63-74d6-a883-ddf6492e83e5
  @spec:demonstrates:01a11687-375e-7667-b8f1-59389fdd9780
  Scenario: Switching View clears the inline Preview diagnostic until the new document is refused
    Given Preview shows the inline diagnostic after a capability failure exhausted recovery
    When the person switches to another View and its Preview document declares a compatible generation
    Then the previous View's diagnostic is gone while the new document loads
    Then the new generation is refused, and the diagnostic shows the failure that exhausted recovery under the refused generation
