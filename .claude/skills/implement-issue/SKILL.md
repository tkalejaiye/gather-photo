---
name: implement-issue
description: Implement a gather.photo Linear issue end-to-end following the team workflow.
disable-model-invocation: true
---
Implement the Linear issue: $ARGUMENTS

1. Read the issue (Linear MCP) — note its acceptance criteria and verification.
2. Read PRD.md and TECH_SPEC.md sections it references.
3. Explore the relevant files, then write a short plan. Confirm scope.
4. Implement, following CLAUDE.md conventions.
5. Verify: npm run typecheck, npm run lint, npm run build, npm run test.
   Show the output — do not assert success.
6. Run the spec-reviewer subagent on the diff. Fix correctness/requirement gaps.
7. Commit (<ISSUE-ID>: <summary>), push, open a PR linking the issue.
8. Move the Linear issue to "In Review".
