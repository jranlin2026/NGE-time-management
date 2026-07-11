# Personal Feishu Time Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing time manager into an 08:00 group-based coach that protects personal-IP and Jixiang OS work with five daily task slots, actionable task progress, escalation, and knowledge-base reviews.

**Architecture:** Keep SQLite as the source of truth. Extend persisted manager settings and task records; make the scheduler enforce project quota/time-window rules; render the resulting state as JSON 2.0 Feishu cards. The service continues to own reminders and durable outbox delivery while Markdown exports become the knowledge-base projection.

**Tech Stack:** Node.js 24, built-in `node:sqlite`, Node test runner, Feishu OpenAPI/WS SDK, Markdown knowledge base.

## Global Constraints

- Daily plan time is `08:00`, review time is `24:00`.
- Max 5 distinct daily tasks; when enough work exists, personal IP >=2 and 极享 OS >=2.
- Personal IP windows: `10:00-12:00`, `14:00-16:00`; 极享 OS windows: `10:00-12:00`, `14:00-24:00`; never schedule `12:00-14:00`.
- Each task block is at most 120 minutes. First and second no-response reminders occur after 10 and 20 minutes.
- Use TDD: every task starts with a failing Node test and ends with the complete suite passing.

### Task 1: Persist coach settings and task checkpoints

**Files:**
- Modify: `src/db/database.mjs`, `src/db/task-repository.mjs`, `src/config.mjs`, `src/manager-app.mjs`
- Modify: `test/database.test.mjs`, `test/task-repository.test.mjs`, `test/manager-app.test.mjs`

- [ ] Write failing tests for `task_checkpoints` persistence and default settings (`08:00`, five slots, 10-minute reminder interval).
- [ ] Add a version-two migration for checkpoints and use settings defaults for project quotas/windows.
- [ ] Run `node --test test/database.test.mjs test/task-repository.test.mjs test/manager-app.test.mjs` and commit `feat: persist coach settings and checkpoints`.

### Task 2: Enforce project quotas, windows, and 120-minute blocks

**Files:**
- Modify: `src/lib/schedule-engine.mjs`, `src/lib/prioritizer.mjs`
- Modify: `test/schedule-engine.test.mjs`, `test/prioritizer.test.mjs`

- [ ] Write failing schedule tests with six tasks proving 2+ IP, 2+ OS, five-task cap, no noon block, and IP priority except an OS blocking bug.
- [ ] Implement candidate selection before block allocation and project-specific windows; split estimates into blocks <=120 minutes.
- [ ] Run `node --test test/schedule-engine.test.mjs test/prioritizer.test.mjs` and commit `feat: enforce daily coach schedule rules`.

### Task 3: Render task checkpoints and require a defer reason

**Files:**
- Modify: `src/lib/feishu-cards.mjs`, `src/lib/feishu-events.mjs`, `src/lib/feishu-messages.mjs`, `src/lib/manager-service.mjs`
- Modify: `test/feishu-cards.test.mjs`, `test/feishu-events.test.mjs`, `test/manager-service.test.mjs`

- [ ] Write failing tests for plan cards with completed/remaining checkpoints and a defer action rejected without a non-empty reason.
- [ ] Add direct JSON 2.0 button/form components and command parsing for `推迟：任务｜原因`; record the reason and replan immediately.
- [ ] Run targeted tests and commit `feat: add checkpoint progress and defer reason`.

### Task 4: Deliver 10+10 group escalation and interruption recovery

**Files:**
- Modify: `src/lib/reminder-engine.mjs`, `src/lib/manager-service.mjs`, `src/manager-app.mjs`
- Modify: `test/reminder-engine.test.mjs`, `test/manager-e2e.test.mjs`

- [ ] Write failing tests for 10-minute @ reminder, 20-minute coaching message, required defer reason, and replan after an explicitly necessary interruption.
- [ ] Implement the two-stage outbox payloads and project-aware recovery.
- [ ] Run `node --test test/reminder-engine.test.mjs test/manager-e2e.test.mjs` and commit `feat: add coaching escalation and recovery`.

### Task 5: Export the 24:00 review into the knowledge base

**Files:**
- Modify: `src/lib/daily-review.mjs`, `src/lib/markdown-export.mjs`, `src/manager-app.mjs`
- Modify: `test/daily-review.test.mjs`, `test/manager-app.test.mjs`

- [ ] Write failing tests asserting completion rate, push reasons, procrastination count, next-day candidates and a review file under `<kbDir>/每日复盘/`.
- [ ] Implement the knowledge-base exporter and schedule 24:00 review.
- [ ] Run targeted tests and commit `feat: export nightly coach review to knowledge base`.

### Task 6: Verify, document, and activate

**Files:**
- Modify: `README.md`, `docs/feishu-setup.md`, `docs/mvp-rules.md`
- Modify: `test/manager-e2e.test.mjs`, `test/launchd.test.mjs`

- [ ] Extend end-to-end test from inbound group command through card delivery/review export.
- [ ] Run `node --test`; verify a real Feishu group command and `launchctl`/manual daemon status.
- [ ] Update setup instructions, commit `docs: document personal time coach workflow`, and record operational blocker if macOS agent cannot remain resident.
