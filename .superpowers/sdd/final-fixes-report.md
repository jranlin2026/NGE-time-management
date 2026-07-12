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
