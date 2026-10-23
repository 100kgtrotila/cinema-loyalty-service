# Implementation Plan: Authoritative loyalty payment facts

**Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)
**Status**: Proposed; implementation requires explicit approval.
**Git branch**: unchanged. Feature ID is not a created Git branch.

## Summary

Один вузький backend PR: persisted PaidAt, stable order/session identity, persisted money та additive loyalty envelope через чинний EF Bus Outbox. Loyalty production behavior залишається чинним. Дизайн/контракт/verification зібрано тут замість окремих research/data-model/contracts/quickstart файлів — явна адаптація Spec Kit до запиту на мінімум дублювання.

## Technical Context / Repository Baseline

| Repository | Checked-out branch / HEAD | Recommended implementation baseline |
| --- | --- | --- |
| Loyalty | docs/loyalty-economy-architecture-spec / 10358b8a6004f7a2e536d2181cae01c9a075fa9f | Preserve current consumer as pinned compatibility target; fetched origin/master = 90f17165e4edcbcaede4ceee7a579177d4840ea4 |
| Backend | fix/gold-checkout-compensation / 7aa5a5c5f9e5bdf7ad0b69feb8e1e48b2681253d | Fresh feature branch from fetched origin/main = a8c5fde74d0d52aad82660f20209e8f8bfe17a47, only after implementation authorization |

Both working trees were clean before SDD scaffolding. Fetch performed; no checkout/merge/rebase/cherry-pick. origin/main is backend remote default. Payment files below are unchanged between local backend HEAD and origin/main. main additionally has booking/hall transactions; retain those changes. Before implementation re-fetch/revalidate baseline and record any adjusted pair.

### Cross-repository implementation handoff

Keep Spec Kit initialized only in loyalty. Start the implementation session with its working directory and writable workspace at a dedicated backend Git worktree created from freshly fetched origin/main; do not create the worktree until implementation is authorized. Provide the five central artifacts by absolute loyalty paths: .specify/memory/constitution.md, docs/loyalty-economy-architecture-spec.md, and this feature's spec.md, plan.md and tasks.md. The backend agent must read backend AGENTS.md plus those artifacts, map B/ to the backend worktree and L/ to the pinned loyalty checkout, and keep all application edits inside backend. Do not copy the master specification, initialize Spec Kit in backend, or write task checkmarks/status back to the central artifacts as implementation side effects. Record the actual baseline pair in the implementation report.

Codex skill invocation is manual from the SDD root/session; merely starting in backend does not discover loyalty skills. Do not invoke the bundled Full SDD Cycle because it includes an implement step. After the separately approved implementation request, use the agreed tasks as the bounded execution checklist; do not let skill availability authorize commit, push, PR, merge, deployment or database reset.

Stack: backend .NET 10, EF Core 9.0.12, Npgsql EF 9.0.4, MassTransit 8.5.5, PostgreSQL/pgvector. Loyalty NestJS 11, Prisma 7, Node.js 22/Bun 1.3.13/Jest. No dependency changes. No new throughput/latency promise; one-column storage change plus existing outbox path.

## Constitution Check

- Minimal scope: one producer PR; no new service/table/framework or global interceptor redesign.
- Atomicity/idempotency: existing checkout lock, nonretrying CheckoutExecutionStrategy, same scoped DbContext/Bus Outbox; persistent consumer dedupe preserved.
- Delivery/recovery: at-least-once, no network charge in retried DB callback, no Unknown-to-success shortcut.
- Verification: real PostgreSQL for persistence/rollback and real RabbitMQ plus pinned unchanged loyalty consumer for compatibility.
- Contracts: additive fields; old aliases, identities and routing preserved.
- Operations: planning only; no migrations applied, no Git mutation/deployment. No destructive baseline operation implied.

No constitution exception required. Constitution cannot be read as permission to implement.

## Research / Current Evidence

Backend paths below are relative to ../cinema-platform-back and verified against origin/main:

- src/Modules/Orders/Cinema.Orders.Domain/Entities/Order.cs: MarkAsPaid stores transaction/status, emits OrderPaidEvent, does not persist PaidAt. SessionId and decimal TotalAmount/PaidAmount/PointsUsed already exist.
- src/Modules/Orders/Cinema.Orders.Application/Orders/Services/OrderCheckoutOrchestrator.cs: ConfirmOrderAsync applies points discount, calls MarkAsPaid, confirms tickets, stages TicketPurchasedEvent then SaveChanges. It currently puts UtcNow in that event. Confirmation failure rechecks persisted Paid/transaction before returning Unknown.
- src/Modules/Orders/Cinema.Orders.Application/Orders/Services/CheckoutExecutionStrategy.cs: retries disabled; CheckoutOrderLock provides existing serialization. Do not auto-retry payment calls.
- src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs: pre-save OrderPaidEvent handler stages email and NestJS messages. Missing email returns before loyalty staging. PurchasedAt is freshly generated; sessionId/paidAt absent.
- src/Cinema.Infrastructure/Persistence/Interceptors/DispatchDomainEventsInterceptor.cs: SavingChanges dispatches raw domain events; wrapped notifications are deferred post-commit. Keep loyalty staging in the pre-save/outbox path, not the wrapped Redis/SignalR notification handler.
- src/Cinema.Infrastructure/ConfigureInfrastructureServices.cs: AddEntityFrameworkOutbox<ApplicationDbContext>, UsePostgres, UseBusOutbox; raw JSON RabbitMQ settings exist.
- tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs: existing paid/outbox rollback and broker recovery tests; some target generic TicketPurchasedEvent, not actual NestJS envelope. Extend exact message coverage.
- tests/Cinema.OrdersTests/PostgresSchemaTemplate.cs uses EnsureCreated, not migrations. Separate migration application test required.
- Loyalty src/loyalty/consumers/ticket-purchased.consumer.ts validates without whitelist rejection; dto/ticked-purchased.dto.ts still requires purchasedAt. processTicketPurchase locks/dedupes before accounting. Additive metadata does not require production DTO changes, subject to real verification.

## Data Model and Interfaces

### Order

Add nullable DateTime PaidAt with private setter, mapped UTC timestamp with time zone by existing EF conventions. Null before confirmed success; set once during first valid MarkAsPaid transition. Choose the timestamp at confirmation, never in asynchronous delivery. It represents local confirmed-recording time, not physical WAL commit instant or provider charge time.

Keep MarkAsPaid(string transactionId) idiomatic if it captures UTC once; use a small explicit UTC argument/clock only if deterministic tests need it, without new generic clock framework. Same transaction replay preserves PaidAt; different transaction remains rejected. Guard actual monetary mutation after PaidAt is present, including cancelled-but-previously-paid orders. Same-value no-op is allowed if needed for replay, conflicting change is rejected. Ensure confirmation checks replay before mutating discounts; do not break legal pre-confirmation GOLD compensation.

No new payment-fact table or historic test-data backfill. TotalAmount, PaidAmount and PointsUsed are authoritative persisted fields and must remain stable after confirmation. Old Paid rows lacking PaidAt must not receive guessed timestamps; fresh disposable fixtures or separately authorized reset resolve test baseline. Confirmed missing timestamp during envelope construction is explicit failure/diagnostic, not a fallback to now.

### Envelope

| JSON field | Value |
| --- | --- |
| pattern | TicketPurchased, unchanged |
| eventId/orderId | Order.Id.Value, unchanged |
| userId/sessionId | Persisted Order.UserId / Order.SessionId.Value; sessionId additive UUID |
| paidAt | Persisted Order.PaidAt serialized UTC ISO-8601; additive |
| purchasedAt | Same instant as paidAt; required old field retained |
| totalAmount/ticketAmount/totalPrice | Existing aliases of persisted Order.TotalAmount |
| paidAmount/pointsUsed | Persisted Order.PaidAmount / Order.PointsUsed |
| foodAmount | Existing 0 |

Keep destination queue:loyalty_ticket_purchased and raw JSON settings. Keep current wire number types/aliases; verify fractional monetary values. Notification metadata remains compatible; use empty safe metadata where optional email is absent rather than making core fact conditional on email. Send TicketPurchasedMessage only when eligible email exists. Do not catch DB/outbox errors to force a green confirmation. Actual email send is downstream and cannot remove committed loyalty staging.

Use PaidAt also for the existing generic TicketPurchasedEvent timestamp in ConfirmOrderAsync. No new transport event identity on retry; MassTransit headers are not business identity. Retry of serialized outbox body preserves all contents. Rebuilding core facts from confirmed Order preserves identity/time/money. Mutable movie/session promotional metadata is not claimed to be a payment-time policy snapshot: that belongs to Stage 4, not this PR.

## Transaction Boundary

External payment success -> existing serialized checkout confirmation -> protected order replay/state check -> persisted money/PaidAt/Paid/transaction + Ticket.Valid -> stage generic and domain-handler NestJS/email records via same scoped EF Bus Outbox -> SaveChanges atomic local commit -> outbox dispatcher performs RabbitMQ I/O.

One SaveChanges implicit transaction can cover this local unit; retain it if PostgreSQL tests prove all staged records are enrolled. Do not add a manual transaction merely for appearance. If an explicit transaction is required by an actual demonstrated enlistment gap, scope only DB changes, within existing nonretrying strategy, and defer notifications until transaction disposal/commit. Test the production scoped IPublishEndpoint/ISendEndpointProvider resolution, not a mock that bypasses Bus Outbox.

Lost commit response is ambiguous. Fresh persisted read may confirm Paid with same transaction; otherwise retain Unknown/reconciliation. No automatic second charge, compensating refund or invented PaidAt merely because SaveChanges threw. After failed staging/SaveChanges, discard contaminated tracked state; do not rely on already-cleared domain events being replayable in that same context.

Source of truth: persisted order payment facts. Outbox: serialized transport copy. Loyalty balance/ledger/intents: derived projections with current transaction guarantees, not new owners of payment time.

## Project Structure / Affected Files

Backend modifications:
- src/Modules/Orders/Cinema.Orders.Domain/Entities/Order.cs
- src/Modules/Orders/Cinema.Orders.Infrastructure/Persistence/Configurations/OrderConfiguration.cs
- src/Cinema.Infrastructure/Migrations/: new EF migration/designer and existing ApplicationDbContextModelSnapshot.cs only as generated by repository tooling
- src/Modules/Orders/Cinema.Orders.Application/Orders/Services/OrderCheckoutOrchestrator.cs
- src/Modules/Orders/Cinema.Orders.Application/EventHandlers/OrderPaidIntegrationEventHandler.cs
- src/Cinema.Application/Orders/IntegrationEvents/NestJsTicketPurchasedEnvelope.cs
- tests/Cinema.OrdersTests/OrderTicketDomainTests.cs
- tests/Cinema.OrdersTests/OrderCheckoutCharacterizationTests.cs
- tests/Cinema.OrdersTests/OrderReservationPostgresTests.cs
- tests/checkout-e2e/run.mjs: only if a focused compatibility probe needs runner wiring; no assertion rewriting or guard bypass

Loyalty is a pinned read/run dependency. No production changes planned. A consumer defect or necessary test-only change outside backend must be reported separately rather than silently expanding repository scope. Keep the implementation as one backend PR with complete model/producer/migration/tests, not an unsafe partial rollout.

## Verification / Quickstart

All following checks are future work; none ran during planning.

| Mandatory PR check | Expected evidence | Requirements |
| --- | --- | --- |
| Domain first/repeated/conflicting MarkAsPaid | Stable PaidAt/event count; no money rewriting | FR-001/003/005/010 |
| PostgreSQL confirmed transition with production-like Bus Outbox DI and EnableRetryOnFailure | Order/ticket + actual NestJS/generic outbox bodies commit together, strategy does not retry charge | FR-004/010 |
| Fault before commit / outbox staging error | No partial PaidAt/Paid/Valid/outbox; fresh context recovery | FR-004 |
| Concurrent checkout confirmations, committed response lost | One charge/effect, stable historical facts; controlled barriers | FR-005/010 |
| Unknown and later confirmed success | No early PaidAt/event; later confirmation uses persisted once-only time | FR-001/004 |
| Missing email and downstream email failure | Loyalty staging/delivery survives; no swallowed storage error | FR-007 |
| Session price changed, fractional amounts, GOLD/points | Persisted core money survives, discounts not reapplied | FR-003/010 |
| Handler reconstruction from committed PostgreSQL order in a new DbContext/scope | Rebuilt envelope matches initial eventId/orderId/userId, sessionId, paidAt/purchasedAt and all monetary fields/pointsUsed; no reused tracked entity or cached envelope | FR-001/002/003/009 |
| Real RabbitMQ unavailable then restarted, process restart after commit | Actual NestJS raw envelope with original facts delivered from persisted outbox | FR-006/009 |
| Real loyalty consumer manual duplicate publish | Same reward/ledger/processed event/achievement intent effect as baseline; proves persistent idempotency, not lost-ACK recovery | FR-008 |
| Clean disposable PostgreSQL migrations | Generated migration applies; EnsureCreated is not evidence of migration correctness | FR-001/004 |
| Pre-commit backend regression gate | Domain, focused PostgreSQL, failure/recovery, migration and Release build/tests run against disposable resources in the implementation worktree; record exact commands, exit codes and skips before creating the backend commit | FR-001…FR-010 |

Reconstruction and serialized retry are separate regressions. For reconstruction, create and commit a confirmed paid order and capture its initial envelope, dispose the scope, reload the order from PostgreSQL in a new DbContext/scope and invoke the real handler/envelope construction path. Compare the core fields listed above, including totalAmount/ticketAmount/totalPrice, paidAmount, foodAmount and pointsUsed. Do not call MarkAsPaid again or reuse the first envelope as the reconstruction input. Separately verify that recovery retries the already serialized outbox message without changing its body.

### Separate cross-service gate: business commit before lost ACK

Harness assessment: B/tests/checkout-e2e/run.mjs runs the pinned L/test/e2e/checkout.transport-spec.ts; its duplicate scenario manually publishes another message and observes ACK. Existing container restart support has no barrier between business commit and channel.ack in L/src/loyalty/consumers/rmq-delivery.service.ts. Polling PostgreSQL followed by docker stop cannot deterministically hit this window. Therefore backend-only PR checks do not claim this recovery scenario; it remains a separately recorded cross-service verification gate, pending authorization for a minimal test-only harness extension. No loyalty production edits, new framework, service or messaging abstraction are required or authorized by this plan.

The gate's reproducible fixture must use the real RabbitMQ channel and production consumer: for one selected eventId, a test-only channel ACK interception withholds the actual ACK frame and signals a barrier; it does not replace the business operation or broker with mocks. At the barrier, an independent PostgreSQL connection verifies committed profile/ledger/processed-event/intents; wait by bounded conditions for the first achievement effects to settle before capturing the comparison baseline. Close that consumer's actual connection before forwarding any ACK, then resume consumption with normal ACK behavior. Use bounded barrier/condition waits and cleanup in finally, not a timing sleep or graceful shutdown that could send the ACK.

Require evidence of the first delivery remaining unacknowledged and a subsequent delivery with RabbitMQ fields.redelivered=true, identical original body/eventId and preserved message properties; a delivery tag may differ and is not an identity. No manual republish or application retry copy may stand in for this broker redelivery. After the second successful ACK, verify the selected message is no longer ready/unacknowledged, one processed event and the expected original ledger/intents remain, and balance/counters/reward/progress have no second business effect. Record exact SHA pair, barrier/redelivery evidence and exit code. If interception or delivery evidence is unavailable, report this gate as NOT RUN/BLOCKED; a green manual-duplicate test does not close it. This gate must pass before claiming lost-ACK recovery verified, but is not silently added as a loyalty change to the backend-only PR.

Commands from backend: dotnet build -c Release; dotnet test tests/Cinema.OrdersTests/Cinema.OrdersTests.csproj -c Release with disposable CINEMA_TEST_POSTGRES_CONNECTION (cinema_orders_test_*), Redis and RabbitMQ; explicitly inspect skips. Reuse repository runners/guards, runtime versions and generated migration workflow. Do not use production/shared resources.

Targeted cross-service compatibility is mandatory after the backend change is committed, on clean checkouts pinned to the exact final backend SHA and the committed loyalty SHA used for SDD baseline: from backend set LOYALTY_REPO to pinned loyalty and run bun tests/checkout-e2e/run.mjs; then from loyalty set MONOLITH_REPO to final backend checkout and run bun run test:transports. Run sequentially, record exact tested SHA pair, exit codes, fixture/mock payment scope and cleanup. A nonzero runner cannot be called passed; unrelated failure must be identified and leaves cross-service acceptance unverified unless separately resolved. Existing standalone loyalty unit/integration/RMQ/build/lint remain regression checks appropriate to final diff; they do not replace the producer/consumer transport proof.

Before commit, execute local backend regressions and Release checks in the dedicated worktree, including migration application only against a verified disposable PostgreSQL database. These checks do not require a clean committed checkout. Only after their results are reviewed may the specifically authorized backend commit be created. Then use clean checkout/worktree state for the SHA-pinned cross-service runners; do not edit either checkout while those runners execute. Record the manual duplicate-publish result separately from the lost-ACK gate. If the latter's test-only barrier is not authorized or cannot run, leave it explicitly NOT RUN/BLOCKED and do not claim lost-ACK recovery verified.

Full economy-program E2E gate (FEFO/debt/post-screening/tier/birthday/requalification/coordinated activation) is Stage 8 and not required or claimed by this PR. Do not implement future rules to make those scenarios pass here. Full backend suite remains subject to current repository/CI requirements when execution is authorized.

## Risks / Complexity Tracking

No justified constitution violation or additional abstraction. External charge/DB commit remain non-atomic; no exactly-once claim. Nullable old disposable PaidAt is deliberate, not hidden backfill. decimal-to-existing-double serialization is retained and tested, not a new money representation design. Metadata snapshot is explicitly deferred. Business blockers: none; implementation approval and a clean feature checkout from current backend main are required operational gates.
