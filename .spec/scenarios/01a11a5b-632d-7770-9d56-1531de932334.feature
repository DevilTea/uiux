Feature: Preview session and runtime lifecycle
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 decision 1 https://github.com/DevilTea/uiux/discussions/131#1-additive-message-types-group-c-foundation; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test asserts the drop. Established by reading code@cf3b984: the Workbench bridge decodes an unknown `type` as invalid (`src/preview/protocol/bridge.ts#L98-L99`, `src/preview/protocol/schema.ts#L193-L195`), and the Workbench fails the generation on an invalid message only before the handshake opens (`app/composables/usePreviewSession.ts#L746`). https://github.com/DevilTea/uiux/blob/cf3b984bc2a55da5be3f2409fd2043eaf39edd1b/app/composables/usePreviewSession.ts#L746
  # Status: built as of cf3b984.
  @spec:id:01a11a5b-632d-7def-ab33-950a0b3955c1
  @spec:demonstrates:01a11a59-d728-751f-bbac-287a77b75610
  Scenario: A message type the Workbench does not know is dropped after the handshake
    Given an acknowledged runtime generation
    When the runtime sends a message whose `type` the Workbench does not know
    Then the Workbench drops the message without effect
    Then the generation and the Preview session stay live
