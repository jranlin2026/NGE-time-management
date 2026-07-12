# Final Whole-Branch Review Fixes

## Status

Implemented all eight final whole-branch review fixes without starting, stopping, or otherwise touching the live service.

## Changes

- Actionable checkpoint tasks now use a stable local ID derived from sorted source message IDs, disposition, and item index. Retrying after a post-create failure returns the same task instead of inserting a duplicate.
- Feishu parents and children retain the official stable `client_token` and also embed a stable managed marker in their descriptions. Crash recovery adopts realistic list results by marker even when list APIs omit `client_token`.
- Direct-message sends include a deterministic Feishu provider `uuid` derived from the durable outbox idempotency key; it is 44 characters and remains unchanged across retries.
- Feishu task synchronization pushes completed checkpoints and locally accepted/done parents through `completed_at`. A `pending_acceptance` parent remains incomplete remotely until acceptance succeeds.
- Every locked one-shot run reconciles stranded accepted project writes before completed-node lookup and normal node processing, reusing the existing acceptance receipt recovery.
- Checkpoint schema, prompt, validator, and policy support `evidence_submission` with nullable `taskId` and structured `{ messageIds, text, links }`. Visible links are source-grounded; image/file references come only from raw Feishu metadata and are never interpreted. A composed E2E proves DM evidence can accept a pending deliverable and update project Markdown/change history exactly once.
- Dry-run `--node` values use the same exported checkpoint validator as normal runs, so misspellings fail before polling.
- Automation repository failures use the shared sanitizer, including Bearer credential redaction for direct callers.

## TDD Evidence

- RED: seven focused regressions failed for stable task identity, marker adoption, completion push, project reconciliation, provider UUID, structured evidence, and direct repository redaction. Additional regression coverage locks the dry-run typo rejection and composed evidence E2E behavior.
- GREEN: focused review suite passed `129/129`, including both parent and child marker adoption.
- Final full-suite verification: `328` passed, `0` failed, `0` skipped.
- Runtime: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test`

## Concerns

- Node reports its existing experimental SQLite warning; it does not fail tests.
- No live Feishu or manager-service restart was performed, by instruction.

## Remaining Final Review Fixes

- Evidence submissions no longer persist `evidence.text` or links authored by the model. Policy reconstructs normalized text, validated URLs, and opaque Feishu image/file references exclusively from the exact referenced inbound messages. Regression coverage proves a hallucinated “已正式发布并验收” claim is discarded.
- Migration 5 adds `automation_runs.analysis_json`. The repository saves the first accepted analysis under the active claim token and preserves it across failed-run reclaim. The runner saves or loads this snapshot before any policy/task side effect, so analyzer reorder or regroup on a hypothetical retry cannot create a second task interpretation; the analyzer is called once.
- Direct one-shot project reconciliation now appends the same idempotent `project-sync-reconciled:${acceptanceId}` event as resident recovery. Repeated checkpoints skip already recovered acceptances.

### TDD and Verification

- RED: four focused failures demonstrated model-authored evidence persistence, missing analysis snapshot APIs, repeated analyzer invocation after failure, and repeated direct reconciliation.
- Focused GREEN: `79` passed, `0` failed.
- Final full-suite verification: `333` passed, `0` failed, `0` skipped.

## Analysis Batch Crash-Window Fix

- Analysis snapshots now persist the exact sorted source `messageIds` alongside the accepted analysis.
- Failed-run reclaim filters current pending input to that persisted ID set and uses only this `analysisBatch` for context, policy, summary idempotency, and inbound finalization. Messages revealed after the failed analysis remain pending even when the polling cursor advances, and are analyzed at the next checkpoint.
- Legacy raw analysis snapshots derive their batch only from the union of `analysis.items[].messageIds`; they never default to all currently pending messages.
- RED proved that message B, revealed between A's failed run and retry, was incorrectly finalized with A. GREEN proves A alone is retried without another analyzer call, B remains pending, and the next node independently analyzes B. Legacy snapshot coverage also proves B is not absorbed.
- Focused runner/repository/E2E verification: `31` passed, `0` failed.
- Final full-suite verification: `335` passed, `0` failed, `0` skipped.

## Atomic Checkpoint Finalization

- `finalizeInbound` now uses one `BEGIN IMMEDIATE` transaction to verify the active claim, validate and mark the exact analysis batch, advance the cursor, and complete `automation_runs` with `completed_at` and the final summary. The persisted analysis snapshot is preserved.
- The checkpoint runner updates its summary before this transaction, passes it into `finalizeInbound`, and no longer calls `completeRun` afterward. `completeRun` remains available for existing non-runner callers and fencing tests.
- RED proved successful inbound finalization could leave a running run and that the runner still used the split completion call. GREEN proves success cannot persist processed messages with a running run, validation failure rolls the whole transaction back, and a simulated pre-atomic failure retries the original persisted batch with one analyzer call and the same outbox idempotency identity/provider UUID input.
- Focused atomic runner/repository/E2E/database verification: `38` passed, `0` failed.
- Final full-suite verification: `336` passed, `0` failed, `0` skipped.
