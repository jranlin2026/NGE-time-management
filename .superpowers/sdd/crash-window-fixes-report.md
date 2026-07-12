# Crash-window fixes report

## Status

Complete. Both final-review crash windows now converge without overwriting durable files or blocking startup.

## Acceptance reconciliation

- Recovery accepts event evidence only when the pending SQLite acceptance has no evidence; non-empty durable evidence must still match exactly.
- The project repository receipt path revalidates operation key, project/deliverable identity, intended evidence, receipt hashes, and the current accepted Markdown effect. Event receipt path and content hash are also checked when present.
- Finalization persists recovered evidence and the accepted task/outbox/audit state transactionally.
- Startup catches each reconciliation independently, appends one idempotent `project_sync_reconciliation_failed` event with attempt/error metadata, and continues with later events and service startup.

## Weekly orphan drafts

- An existing immutable draft is parsed and adopted on `EEXIST` only when it is a valid draft with the exact requested week/version/path identity.
- Invalid or mismatched files are rejected and never overwritten.
- SQLite and outbox persistence use the adopted Markdown plan/hash/path/created time, not retry analyzer output.

## TDD evidence

- RED: focused regression run produced 5 expected failures covering empty-evidence recovery, reconciliation isolation, orphan adoption, invalid orphan rejection, and service persistence from the adopted draft.
- GREEN: focused crash/recovery tests: 12 passed, 0 failed.
- Full suite: 193 passed, 0 failed.
- `git diff --check`: clean.
- No live services or external APIs were used.

## Concerns

- Node prints its existing experimental SQLite warning; there are no test errors or application warnings introduced by this change.
