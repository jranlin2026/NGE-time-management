# Task 2 report: Operational database schema

## Implementation

- Added migration 3 with project execution fields on `tasks` and the `weekly_plans`, `task_acceptances`, and `project_sync_state` tables.
- Extended task create/update/read mapping for `projectId`, `milestoneId`, `deliverableId`, `requiresEvidence`, and `impact`.
- Added `createProjectOperationsRepository(db, deps)` with all required weekly plan, acceptance, and sync-state methods.
- JSON values are serialized at persistence boundaries and mapped back to objects; confirmation events and acceptance submissions use unique keys for idempotency.

## TDD evidence

- RED 1: targeted database/task tests failed 2/9 as expected: missing `project_id`; mapped `projectId` was `undefined`.
- GREEN 1: targeted database/task tests passed 9/9 after migration and task mapping implementation.
- RED 2: repository test failed because `project-operations-repository.mjs` did not exist.
- GREEN 2: all three targeted files passed 12/12 after repository implementation.

## Verification

- Focused: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/database.test.mjs test/task-repository.test.mjs test/project-operations-repository.test.mjs` — 12 passed, 0 failed.
- Full suite: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test` — 90 passed, 0 failed.
- `git diff --check` passed.

## Files

- Modified: `src/db/database.mjs`, `src/db/task-repository.mjs`, `test/database.test.mjs`, `test/task-repository.test.mjs`.
- Created: `src/db/project-operations-repository.mjs`, `test/project-operations-repository.test.mjs`.

## Self-review and concerns

- Reviewed migration ordering, placeholder counts, boolean conversion, JSON boundaries, missing-record errors, and idempotent duplicate behavior.
- No Task 1 source files were changed. Markdown remains the formal project source of truth.
- Concern: SQLite emits its existing experimental-feature warning under Node 24; tests remain clean otherwise.

## Review follow-up

- Added a regression proving that `saveWeeklyPlan` cannot downgrade or mutate an already confirmed week/version and that retrying the original confirmation remains confirmed with intact metadata.
- Added a real file-backed version-2 upgrade regression with an existing task; reopening via `openDatabase` preserves old values and applies migration-3 defaults (`NULL`, `0`, and `normal`).
- RED: targeted run failed 1/14 because saving the confirmed version as draft did not throw; the v2 upgrade regression already passed against the migration implementation.
- GREEN: exact targeted command passed 14/14 after adding the confirmed-plan immutability guard.
- Full suite after the fix passed 92/92; `git diff --check` passed.
