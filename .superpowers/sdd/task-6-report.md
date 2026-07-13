# Task 6 report: Full briefs and change-only checkpoint messages

## Status

- DONE
- Feature commit: `87cfeeee3d54a19f2a3bb873e9e015810a5f5ae4` (`feat: send executable checkpoint briefs`)

## Implementation

- Replaced the 08:00 four-line summary with `renderDailyExecutionBrief()`, including configured local times, work content, completion standards, feedback rules, feedback nodes, and do-not-do constraints.
- Wired `timezone` and the persisted current schedule from `manager-app.mjs` into checkpoint policy evaluation.
- Captured pre-node schedules and diffed stable `(taskId, checkpointIndex)` identities into deterministic chronological added, removed, and moved interval lines.
- Replaced ordinary 09/12/15/18/21 hard-coded replies with one `renderPlanDelta()` message containing facts, explicit schedule changes, one current action, and the next absolute feedback deadline.
- Kept quiet checkpoints silent when there are no facts or tuple changes, even when a current action exists; kept 24:00 on the existing review path.
- Preserved the doing task identity and interval during ordinary new-input replans; 18:00 names kept and removed work; 21:00 sends only for an unfinished critical outcome and handles a next-day midnight end as `24:00`.
- Returned the newly generated schedule from manager actions, including `complete_checkpoint`, and propagated remote-progress replans into policy state.
- On task-sync failure, queued and flushed the fixed private warning under `private-sync-failure:${workDate}:${node}`, then rethrew the original error so the automation run remains failed and retryable.

## TDD evidence

- 08:00 RED: policy expected `10:15–10:35`, work content, completion standard, and feedback rules; the old renderer returned only four summary lines. GREEN passed after using the Task 4 full-brief renderer.
- Sync/manager RED: no private sync-failure row existed and `complete_checkpoint` returned no schedule. GREEN passed after failure notice/rethrow handling and schedule-return wiring.
- Delta RED: five policy cases failed with the old hard-coded replies: 12:00 early completion, 12:00 delay, 15:00 ordinary input, 18:00 kept/removed work, and 21:00 final outcome. GREEN passed after schedule capture/diff and `renderPlanDelta()` integration.
- Wiring RED proof: with the manager-app policy wiring temporarily removed, the Tokyo E2E expected `11:00–11:30` but rendered the Shanghai default `10:00–10:30`; restoring the wiring made it pass.
- 21:00 edge RED: a 23:30–midnight block rendered `23:30–00:00` and was skipped as the current action; an unchanged unfinished doing outcome stayed silent. GREEN normalized the end to `24:00` and emitted a final-sprint fact with the actual action and 24:00 deadline.

## Verification

- Planned focused suite: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-policy.test.mjs test/checkpoint-runner.test.mjs test/manager-service.test.mjs test/checkpoint-e2e.test.mjs` — 67 passed, 0 failed.
- Related renderer/schedule/app suite — 36 passed, 0 failed.
- Fresh full suite: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test` — 377 passed, 0 failed, 0 skipped.
- `git diff --check` and `git diff --cached --check` passed.
- Only the eight Task 6 source/test files were staged and committed.

## Files committed

- `src/lib/checkpoint-policy.mjs`
- `src/lib/checkpoint-runner.mjs`
- `src/lib/manager-service.mjs`
- `src/manager-app.mjs`
- `test/checkpoint-policy.test.mjs`
- `test/checkpoint-runner.test.mjs`
- `test/manager-service.test.mjs`
- `test/checkpoint-e2e.test.mjs`

## Self-review

- Standards axis: 0 findings. The implementation stays within existing policy/runner/manager boundaries, uses deterministic pure schedule formatting helpers, preserves injected I/O, and follows ESM plus `node:test` conventions.
- Spec axis: 0 findings. Tests cover 08 full brief, quiet 09 with an available current action, early completion, delay/scope reduction, doing-block protection, evening trimming, final sprint, midnight normalization, sync-failure notice, failed-run retry semantics, and E2E configured timezone output.

## Concerns and scope

- No live Feishu calls, external writes, automation changes, service lifecycle actions, or production database changes were performed.
- Pre-existing modifications to `.superpowers/sdd/task-2-report.md` and `.superpowers/sdd/task-5-report.md` were preserved and excluded from the commit.
- No blockers. The test suite emits the repository's existing SQLite experimental-feature warning; all assertions pass.
