# Orphan weekly-plan semantic validation report

## Outcome

- Exported `validateWeeklyPlan` from `codex-analyzer.mjs` as the single canonical semantic validator.
- `weeklyPlanning.generateDraft` now validates the exact durable plan returned by `weeklyPlanRepository.writeDraft` against the current active projects before writing SQLite or enqueuing the weekly-plan outbox card.
- The same validation path covers newly published drafts and immutable orphan drafts adopted after a retry.
- The validator covers known project, milestone, and deliverable bindings; proposed deliverable changes; accepted/evidence immutability; unique task and deliverable-change identities; bounded positive integer minutes; valid date strings; required evidence; and allowed impact values.

## TDD evidence

Red command:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test --test-name-pattern='semantically invalid orphan' test/weekly-planning-service.test.mjs
```

Observed: 1 test failed because `generateDraft` did not reject the invalid orphan (`Missing expected rejection`).

Green focused command:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/codex-analyzer.test.mjs test/weekly-planning-service.test.mjs
```

Observed: 29 passed, 0 failed. This includes a second red-green regression proving impossible calendar dates are rejected rather than normalized by JavaScript date parsing.

Full-suite command:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
```

Observed: 195 passed, 0 failed.

Diff check:

```sh
git diff --check
```

Observed: exit 0, no whitespace errors.

## Regression coverage

The new regression publishes a syntactically parseable orphan Markdown draft with matching week, version, and draft status but invalid semantic references and task constraints. A retry now rejects it, leaves no SQLite weekly-plan row, enqueues no weekly-plan card, and preserves the orphan bytes unchanged. The pre-existing valid-orphan adoption regression continues to pass and verifies exact, once-only persistence.

## Concerns

No live service was started or modified. The repository parser remains intentionally syntax-focused; semantic validation is enforced at the service boundary before database/outbox effects.
