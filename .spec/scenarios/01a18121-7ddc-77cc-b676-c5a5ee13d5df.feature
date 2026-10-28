Feature: Product Kit
  # Source: Discussion #379 (closed loop) [#379 body: D1: Kit components are the shared source](https://github.com/DevilTea/uiux/discussions/379) (#205); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Status: not built; tracked in issue #380 (https://github.com/DevilTea/uiux/issues/380).
  @spec:id:01a18121-7ddc-74dd-b7a3-38bb5315f5e9
  @spec:demonstrates:01a11bb1-8c9b-78a8-b359-c083412d9789
  @spec:demonstrates:01a11bb1-9bef-7d8f-8577-c525dd917149
  @spec:demonstrates:01a11bb1-a630-7c7c-8dd3-5e0a11e4e919
  Scenario: Components diff reports a file that upstream added to a copied component
    Given a product project whose copy record lists one file of the component `button`
    Given the Workspace's registry has since added a second file to `button`
    When an operator runs `uiux components diff --check`
    Then the second file is reported as `added` and the command exits with status 1
