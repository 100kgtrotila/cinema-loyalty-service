# Tasks: Authoritative loyalty payment facts

**Input**: [spec.md](spec.md), [plan.md](plan.md), [constitution](../../.specify/memory/constitution.md).
**Status**: Planning only; explicit implementation approval required. All tasks unexecuted.
**Paths**: B/ = backend repository or future clean feature checkout; L/ = loyalty checkout. Do not execute B/ paths in loyalty.

## Phase 1 — Baseline and Regressions

- [ ] T001 Verify B/AGENTS.md, working trees and refreshed origin/main; after authorization create implementation branch from main no older than a8c5fde74d0d52aad82660f20209e8f8bfe17a47, without merging old local branch. Pin L/ and revalidate plan.md.
- [ ] T002 [US1] Add failing first/repeat/conflicting PaidAt and immutable-money regressions in B/tests/Cinema.OrdersTests/OrderTicketDomainTests.cs; confirm old-code failure cause (FR-001/003/005/010).
- [ ] T003 [US2] Add failing actual NestJS envelope/no-email regressions in B/tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs with production-like scoped EF Bus Outbox; verify old-code failures (FR-006/007).

## Phase 2 — US1: Stable Confirmed Facts

Independent test: PostgreSQL order/ticket and serialized outbox core facts match. Schema, producer and tests are one coupled deliverable, not separate partial rollouts.

- [ ] T004 [US1] Add once-only UTC PaidAt and minimal post-confirmation money protection in B/src/Modules/Orders/Cinema.Orders.Domain/Entities/Order.cs; preserve same-payment replay and legitimate pre-confirmation GOLD compensation (FR-001/003/005/010).
- [ ] T005 [US1] Map PaidAt in B/src/Modules/Orders/Cinema.Orders.Infrastructure/Persistence/Configurations/OrderConfiguration.cs; generate new EF migration/designer/model snapshot in B/src/Cinema.Infrastructure/Migrations/; no old migration edits or guessed time backfill (FR-001/004).
- [ ] T006 [US1] Add sessionId/paidAt and preserve purchasedAt alias/old fields in B/src/Cinema.Application/Orders/IntegrationEvents/NestJsTicketPurchasedEnvelope.cs; use persisted facts in B/src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs (FR-002/003/006/009).
- [ ] T007 [US1] Use persisted PaidAt also in generic event in B/src/Modules/Orders/Cinema.Orders.Application/Orders/Services/OrderCheckoutOrchestrator.cs; check replay before discount mutation, preserve lock/nonretrying strategy/Unknown recovery. Do not add manual transaction if single SaveChanges already covers the unit (FR-004/005/010).
- [ ] T008 [US1] Extend B/tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs with actual NestJS/generic body checks, PaidAt/Paid/Valid commit/rollback, staging fault and fresh-context recovery, production EnableRetryOnFailure without recharging (FR-001/004).
- [ ] T009 [US1] Extend B/tests/Cinema.OrdersTests/OrderCheckoutCharacterizationTests.cs and OrderReservationPostgresTests.cs for Unknown→success, lost commit response, concurrent confirmations with barriers, GOLD/points replay and fractional persisted money after pricing changes (FR-003/005/010).

## Phase 3 — US2: Independent Reliable Delivery

Independent test: no-email and broker/process recovery deliver original fact; duplicate has no second effect. Depends on US1 envelope/schema.

- [ ] T010 [US2] Separate optional email branch from mandatory loyalty staging in B/src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs; preserve notification contracts, propagate storage failures, do not move staging to post-commit notification (FR-007).
- [ ] T011 [US2] Extend B/tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs for no-email/downstream email failure, actual NestJS raw JSON, broker outage→recovery and new publisher process/scope after commit, stable core facts (FR-006/007/009).
- [ ] T012 [US2] Use B/tests/checkout-e2e/run.mjs with pinned L/ to verify actual consumer, duplicate/lost ACK, profile/ledger/processed-event/intents. Reuse strict L/test/e2e/checkout.transport-spec.ts assertions; put necessary producer-only probe in B/tests/checkout-e2e/, no loyalty production edits (FR-008).

## Phase 4 — PR Exit Gate

- [ ] T013 Apply generated B/src/Cinema.Infrastructure/Migrations/ migration on clean disposable PostgreSQL with repository EF workflow; EnsureCreated in B/tests/Cinema.OrdersTests/PostgresSchemaTemplate.cs does not prove migration correctness. No shared/reset operations.
- [ ] T014 Run B/ Release build, domain/focused and PostgreSQL OrdersTests with infrastructure; inspect skips and plan.md matrix. Complete current repository/CI gates on final head, record exact commands and exit codes.
- [ ] T015 Sequentially run B/tests/checkout-e2e/run.mjs and L/test/run-transports.mjs via bun run test:transports, LOYALTY_REPO/MONOLITH_REPO, on clean committed final SHA pair; verify cleanup and existing GOLD/refund/idempotency regressions. Do not bypass clean guards.
- [ ] T016 Review final B/ diff against spec.md FR-001…FR-010, update minimal existing B/ documentation if needed and prepare evidence: migration, actual tests, SHA pair, limitations/exclusions. Git publication requires separately authorized workflow.

## Dependencies and Execution

T001 → T002/T003 → T004/T005 → T006/T007 → T008/T009 → T010/T011 → T012 → T013…T016. Regression writing precedes implementation. Do not activate model/producer/transaction behavior as unsafe intermediate states. 16 tasks: US1 7, US2 4, baseline/exit 5.

Read-only review or test preparation in separate files can be parallel after authorization; shared handler/fixture edits and Docker harnesses run sequentially. Do not split this into independently deployed stories just to match the template.

## PR Exit Criteria

SC-001…SC-004 proven by executed checks; current consumer compatible; actual migration verified separately; stable core facts and atomic local unit; Unknown and repeated charge behavior preserved. No future economy implementation. Full Stage 8 gate is not claimed. No checkbox is completed: this is a plan, not an execution report.
