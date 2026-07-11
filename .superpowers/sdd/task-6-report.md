# Task 6 Report: Evidence collection and acceptance decisions

## Status

Complete.

## Implemented

- Routed `requiresEvidence` completion from `doing` to `pending_acceptance`, while preserving direct completion for ordinary tasks.
- Added the acceptance service public API: `request`, `submit`, and `decideByUser`.
- Persisted pending and decided acceptance records through the existing project operations repository.
- Added deterministic URL, quantity, and file-reference checks before Codex analysis.
- Added a restricted Codex acceptance schema with `accepted`, `rejected`, and `needs_user_confirmation` outcomes.
- Made analyzer failures, invalid analyzer responses, Feishu images, and file references require manual review.
- Added Feishu evidence parsing, evidence request cards, and manual accept/reject cards and callbacks.
- Added idempotency handling for repeated evidence submissions and manual decisions.

## TDD evidence

- RED: project deliverable completion initially returned `complete`; state machine rejected `request_acceptance`.
- GREEN: evidence completion routing and state transitions passed.
- RED: `normalizeEvidenceMessage` was missing and Feishu image events were unsupported.
- GREEN: URL/image/file evidence parsing and AI-failure manual review passed.

## Verification

- Targeted and adjacent suite: 58 passed, 0 failed.
- Full suite: 147 passed, 0 failed.
- `git diff --check`: passed.

- Runtime: Node v24.14.0 from the bundled Codex runtime (Node was not on the shell's default PATH).

## Self-review

- Ordinary tasks still use the existing direct `doing -> done` completion path.
- Uninspectable image/file references cannot reach automatic acceptance.
- Task 7 project Markdown progress writeback was intentionally not implemented here.

## Concerns

- None blocking. When multiple tasks await acceptance, evidence is not guessed onto a task; the current message handler only auto-routes evidence when exactly one pending acceptance exists.

## Review fixes

- Result messages now preserve arbitrary text/quantity conclusions as text evidence and also extract any URLs; recognized result messages never fall through to task ingestion.
- Image and file evidence carries sender, chat, and source-message identity. Evidence authorization is checked before acceptance lookup or mutation.
- Submission now performs read-only pending validation, runs async analysis without mutation, then re-reads and commits the acceptance decision, task transition, manual-review outbox, and idempotency event in one shared SQLite transaction.
- Duplicate submissions return the persisted acceptance decision. Late/replayed evidence without a pending task and acceptance is rejected before any durable event.
- URL syntax and count are validation gates only. Valid URLs require analyzer verification; analyzer failure, unreadable URLs, or uncertain relevance require user confirmation.

### Review RED/GREEN evidence

- RED: review identified text-only results falling into task ingestion, media evidence without source metadata, URL-count auto-acceptance, and non-atomic writes before validation.
- GREEN: added routing and authorization regressions, unreachable/irrelevant URL regressions, late-evidence checks, and injected failures after acceptance, task, outbox, and event writes.
- Failure-injection tests prove every partial write rolls back and retrying the same idempotency key converges without stranding `pending_acceptance`.
- Review Task 6 target suite: 43 passed, 0 failed.
- Expanded target plus manager-app routing suite: 52 passed, 0 failed.
- Review full suite: 156 passed, 0 failed.
- `git diff --check`: passed.

## Final review fixes

- Feishu card action parsing now retains the callback operator `open_id`, including direct and nested operator shapes. Manual accept/reject is denied before mutation unless the actor matches the configured manager user.
- Only explicit result messages and image/file message kinds enter acceptance routing. An ordinary message that happens to contain a URL continues through normal task/chat handling.
- Accepted or rejected evidence now atomically appends both the state-machine audit event (`task_accepted`/`task_rejected`) and `acceptance_evidence_submitted`, with distinct stable idempotency keys.
- Retry tests assert exactly one event of each kind. Failure after the transition audit write rolls back the acceptance, task, and both events before retry.

### Final RED/GREEN evidence

- RED: card callbacks lacked actor identity, ordinary URL messages could be captured by a pending acceptance, and acceptance transitions lacked their state-machine audit event.
- GREEN: realistic Feishu operator-shape tests, unauthorized callback tests, unrelated URL routing regression, and dual-event rollback/idempotency tests all pass.
- Task 6 target suite: 45 passed, 0 failed.
- Expanded acceptance/routing/card suite: 66 passed, 0 failed.
- Full suite: 161 passed, 0 failed.
- `git diff --check`: passed.
