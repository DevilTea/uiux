Feature: A Preview report without coverage makes Checks' Runtime errors source incomplete, never zero findings
  @spec:id:01a17940-2f48-715a-a705-817e54b1e885
  @spec:demonstrates:01a115cd-bb96-7131-99d9-a3882829590c
  Scenario: A Preview report without coverage makes Checks' Runtime errors source incomplete, never zero findings
    Given a live Preview with no Runtime to inspect whose `checks.report` carries no coverage and no Runtime error
    When Checks shows the Preview's sources
    Then the Preview's Runtime errors source is incomplete
    Then it is not shown as completed with zero findings
