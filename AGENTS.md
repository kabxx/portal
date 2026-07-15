# Repository Change Workflow

This file defines how agents must modify this repository. Project architecture and feature-specific behavior belong in the relevant documentation and should be read only when needed.

## Modifying or Adding Features

1. Clarify the user's requirements before planning or implementation. Ask focused questions about the goal, scope, expected behavior, constraints, and acceptance criteria, with the depth and number of questions matched to the complexity of the request.

2. Read the project documentation relevant to the requested change.

3. Inspect the related code, existing tests, current branch, and working tree. Understand the existing implementation before proposing changes, and preserve all user changes that are outside the task.

4. Research established solutions for similar situations. Treat online material as a reference for best practices, not as code to copy directly. Prefer official documentation and reliable implementations over informal examples.

5. Design a solution that fits the current repository and remains maintainable and reasonably extensible. Do not apply a temporary patch that leaves the underlying problem unresolved, and do not over-engineer for hypothetical future requirements.

6. Give the proposed implementation plan, risks, and tradeoffs to a sub-agent for review. Address its findings, then present the reviewed plan to the user. Do not begin implementation until the user explicitly approves the plan.

7. After approval, create a dedicated Git worktree and branch for the implementation. Make only changes that are necessary for the approved scope.

8. When the implementation is complete, give the actual code changes and tests to a sub-agent for review. The review must focus on defects, regressions, edge cases, maintainability, and divergence from the approved plan.

9. Resolve the review findings and verify the changes again. If important issues were found, repeat the sub-agent review until no blocking issue remains.

10. Check whether the change requires new or updated tests, configuration migration, or documentation. Update them when required by the implemented behavior.

11. Run the relevant tests, type checks, and formatting checks. Do not merge while required verification is failing. If a check cannot run because of the environment or missing fixtures, report that limitation explicitly.

12. After verification succeeds, commit the changes and merge the implementation branch into the target branch. Confirm that the target working tree is in the expected state after the merge.

13. Remove the worktree and branch created for the task. Do not remove or alter user-owned branches, files, worktrees, or uncommitted changes.

14. Report the completed behavior, important design decisions, review findings, verification results, commit and merge records, and any remaining limitations to the user.

## General Rules

- Treat every update as a breaking change by default. Preserve compatibility with legacy APIs, configuration fields, command syntax, data formats, or previous behavior only when the user explicitly requests backward compatibility.
- Never claim that documentation was read, a review was completed, or a check passed unless it actually happened.

> **Required review fallback:** If a sub-agent is unavailable, a human must review the plan and implementation before the work proceeds to the next approval or merge stage.
