# Tasks: Authoritative loyalty payment facts

**Input**: [spec.md](spec.md), [plan.md](plan.md), [constitution](../../.specify/memory/constitution.md).
**Status**: Planning only; explicit implementation approval required. All tasks unexecuted.
**Paths**: B/ = backend repository or future clean feature checkout; L/ = loyalty checkout. Do not execute B/ paths in loyalty.

## Phase 1 — Baseline and Regressions

- [ ] T001 Verify B/AGENTS.md, both working trees and refreshed origin/main; after implementation authorization create a dedicated B/ Git worktree and feature branch from the refreshed origin/main (current verified floor: a8c5fde74d0d52aad82660f20209e8f8bfe17a47), without merging the old local branch. Pin the clean committed L/ SHA. Read the five central SDD artifacts by absolute path; map B/ to the backend worktree and L/ to the pinned loyalty checkout. Keep application edits in B/ only; do not copy or reinitialize SDD or write task status back to L/.
- [ ] T002 [US1] Add failing first/repeat/conflicting PaidAt and immutable-money regressions in B/tests/Cinema.OrdersTests/OrderTicketDomainTests.cs; confirm old-code failure cause (FR-001/003/005/010).
- [ ] T003 [US2] Add failing actual NestJS envelope/no-email regressions in B/tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs with production-like scoped EF Bus Outbox; verify old-code failures (FR-006/007).

## Phase 2 — US1: Stable Confirmed Facts

Independent test: PostgreSQL order/ticket and serialized outbox core facts match. Schema, producer and tests are one coupled deliverable, not separate partial rollouts.

- [ ] T004 [US1] Add once-only UTC PaidAt and minimal post-confirmation money protection in B/src/Modules/Orders/Cinema.Orders.Domain/Entities/Order.cs; preserve same-payment replay and legitimate pre-confirmation GOLD compensation (FR-001/003/005/010).
- [ ] T005 [US1] Map PaidAt in B/src/Modules/Orders/Cinema.Orders.Infrastructure/Persistence/Configurations/OrderConfiguration.cs; generate new EF migration/designer/model snapshot in B/src/Cinema.Infrastructure/Migrations/; no old migration edits or guessed time backfill (FR-001/004).
- [ ] T006 [US1] Add sessionId/paidAt and preserve purchasedAt alias/old fields in B/src/Cinema.Application/Orders/IntegrationEvents/NestJsTicketPurchasedEnvelope.cs; use persisted facts in B/src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs (FR-002/003/006/009).
- [ ] T007 [US1] Use persisted PaidAt also in generic event in B/src/Modules/Orders/Cinema.Orders.Application/Orders/Services/OrderCheckoutOrchestrator.cs; check replay before discount mutation, preserve lock/nonretrying strategy/Unknown recovery. Do not add manual transaction if single SaveChanges already covers the unit (FR-004/005/010).
- [ ] T008 [US1] Extend B/tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs with actual NestJS/generic body checks, PaidAt/Paid/Valid commit/rollback, staging fault and fresh-context recovery, production EnableRetryOnFailure without recharging. Separately commit a confirmed paid order, capture its initial envelope, dispose the scope, reload the committed order in a new DbContext/scope and invoke the real handler/envelope construction path; compare eventId/orderId/userId, sessionId, persisted paidAt/purchasedAt and every monetary field/pointsUsed. Do not reuse tracked state or the initial envelope as input (FR-001/002/003/004/009).
- [ ] T009 [US1] Extend B/tests/Cinema.OrdersTests/OrderCheckoutCharacterizationTests.cs and OrderReservationPostgresTests.cs for Unknown→success, lost commit response, concurrent confirmations with barriers, GOLD/points replay and fractional persisted money after pricing changes (FR-003/005/010).

## Phase 3 — US2: Independent Reliable Delivery

Independent test: no-email and broker/process recovery deliver original fact; duplicate has no second effect. Depends on US1 envelope/schema.

- [ ] T010 [US2] Separate optional email branch from mandatory loyalty staging in B/src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs; preserve notification contracts, propagate storage failures, do not move staging to post-commit notification (FR-007).
- [ ] T011 [US2] Extend B/tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs for no-email/downstream email failure, actual NestJS raw JSON, broker outage→recovery and new publisher process/scope after commit; assert unchanged already serialized outbox body. This serialized-message retry test is distinct from T008 handler reconstruction (FR-006/007/009).
- [ ] T012 [US2] After the authorized backend commit, use B/tests/checkout-e2e/run.mjs with pinned clean L/ for the manual duplicate-publish idempotency test and profile/ledger/processed-event/intents assertions; reuse strict L/test/e2e/checkout.transport-spec.ts assertions and put necessary producer-only probes in B/tests/checkout-e2e/. Record real commit-before-ACK redelivery as a separate cross-service gate using plan.md's barrier/connection-close/redelivered=true scenario. Current harness lacks the ACK barrier; its minimal test-only extension requires separate cross-service scope authorization, never loyalty production edits. Report manual-duplicate and lost-ACK results separately: completing the backend task does not mark the external gate passed; absent actual execution/evidence it remains NOT RUN/BLOCKED (FR-008).

## Phase 4 — PR Exit Gate

- [ ] T013 Before backend commit, apply the generated B/src/Cinema.Infrastructure/Migrations/ migration on a clean disposable PostgreSQL database with the repository EF workflow; EnsureCreated in B/tests/Cinema.OrdersTests/PostgresSchemaTemplate.cs does not prove migration correctness. No shared/reset operations.
- [ ] T014 Before backend commit, run B/ Release build plus domain/focused and PostgreSQL OrdersTests with disposable infrastructure; inspect skips and the plan.md matrix. Record commands, exit codes and limitations. Fix failures and repeat affected checks before asking for/using separate authorization to commit.
- [ ] T015 After the authorized backend commit, sequentially run B/tests/checkout-e2e/run.mjs and L/test/run-transports.mjs via bun run test:transports, LOYALTY_REPO/MONOLITH_REPO, on clean committed final SHA pair; verify cleanup and existing GOLD/refund/idempotency regressions. Do not bypass clean guards.
- [ ] T016 Review final B/ diff against spec.md FR-001…FR-010, update minimal existing B/ documentation if needed and prepare evidence: migration, actual tests, SHA pair, limitations/exclusions. Git publication requires separately authorized workflow.

## Dependencies and Execution

T001 → T002/T003 → T004/T005 → T006/T007 → T008/T009 → T010/T011 → T013 → T014 → separately authorized backend commit → T012/T015 → T016. Regression writing precedes implementation. T012/T015 require clean committed SHA-pinned checkouts; they cannot be moved before the commit gate. Do not activate model/producer/transaction behavior as unsafe intermediate states. 16 tasks: US1 7, US2 4, baseline/exit 5.

Read-only review or test preparation in separate files can be parallel after authorization; shared handler/fixture edits and Docker harnesses run sequentially. Do not split this into independently deployed stories just to match the template.

## PR Exit Criteria

SC-001…SC-004 proven by executed checks; current consumer compatible; actual migration verified separately; stable core facts and atomic local unit; Unknown and repeated charge behavior preserved. No future economy implementation. Full Stage 8 gate is not claimed. No checkbox is completed: this is a plan, not an execution report.

T008 reconstruction and T011 serialized retry require separate evidence. T014 is the pre-commit local gate; T012/T015 are post-commit clean-checkout gates. T012's manual duplicate check belongs to this backend PR; the separately scoped lost-ACK gate retains its own pending/result status in the verification report and is not counted as passed by completing T012 or green existing runners. A backend-only PR may report that explicit verification limitation without claiming lost-ACK recovery verified. Task status is reported in the implementation session; updating central task checkboxes is not an implementation side effect.
