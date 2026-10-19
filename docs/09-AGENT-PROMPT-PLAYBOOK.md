# Agent execution playbook

## Agent role split (even if a single coding model)
- **Planner:** reads PRD/ADRs, writes scoped tasks and failure-state acceptance criteria, does not code.
- **Frontend:** web, UI, SEO, performance, a11y, screenshots; consults web AGENTS.
- **Backend:** contracts, API, worker, DB and finance state; consults API/worker AGENTS.
- **Security reviewer:** checks threats, privacy, authz and financial invariants before merge.
- **QA reviewer:** exercises full mocked path, perf budgets, keyboard/mobile, provider faults.

Avoid simultaneous edits to package manager configs, DB schema, contract types or shared tokens; designate owner per shared file. Parallelize only independent tasks. Merge through short PRs.

## Handoff contract
Input: task ID, acceptance criteria, relevant PRD section, exact files, dependencies, blocked decisions. Output: patch, commands run, tests, screenshots, migration note, risks, instructions for next agent.

## Strict command behavior
Never say 'installed', 'passed', 'deployed', 'verified', 'configured' unless actual command or artifact proves it. Missing credential is blocker: use mock adapter and document what remains. Fail closed on unknown finance states.

## Example task prompt
'Implement PR-003 on a new branch. Read root and apps/web AGENTS.md. Use locked brand colors; server render public profile; add loading/error states, mobile accessibility, metadata and tests; do not add payment integration. Start by reporting repository inventory and plan; finish with command outputs and screenshots.'
