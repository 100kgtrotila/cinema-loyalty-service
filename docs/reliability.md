# Distributed reliability contract

This document captures invariants and review questions, not a claim that every invariant has already been implemented. Validate against the current working tree before asserting compliance.

## Service flow

- The .NET cinema platform calls loyalty gRPC endpoints and produces RabbitMQ business events.
- `TicketPurchasedConsumer` validates inbound events and delegates purchase handling to `LoyaltyService`.
- PostgreSQL holds loyalty profiles, ledger, processed event records, achievement progress, and the existing tier outbox.
- Redis/BullMQ transports background jobs. `AchievementsProcessor` modifies progress/rewards in PostgreSQL.
- Purchase/VIP transactions save `AchievementDispatchIntent` rows atomically; `AchievementIntentPublisher` retries BullMQ delivery. RabbitMQ tier outbox has a separate claim/lease/token recovery mechanism. Their retry and ownership guarantees differ; see `docs/achievement-delivery.md` and README.

## Non-negotiable invariants

1. **Commit and intent:** if a durable downstream action is required after a business commit, record its dispatch intent in the same DB transaction. Never put an external enqueue operation in a transaction retry callback.
2. **At least once:** a sender may retry after the receiving broker committed a message but the sender did not receive confirmation. Duplicate deliveries are normal.
3. **Idempotent consumer:** the same event must not create extra points, progress, ledger rows, or unlock rewards. Persistent uniqueness/dedupe must be coupled transactionally with business effects.
4. **Concurrency:** simultaneous changes to one user's balance/tier must use the established profile lock and re-read current values under lock.
5. **Claim ownership:** multiple publisher instances must not claim the same pending row at the same time. Use atomic update/compare-and-set or batch `FOR UPDATE SKIP LOCKED` plus a recoverable lease and fencing.
6. **Crash recovery:** a PROCESSING or leased event can be reclaimed after the worker dies; stale workers cannot overwrite newer attempts.
7. **Retry classes:** transient errors retry with bounded backoff and jitter; invalid payloads and other permanent failures become visible for investigation/replay.
8. **Finite resources:** bounded concurrency, batch size, connections, memory, deadlines, and predictable shutdown.
9. **Broker timeout ambiguity:** `Promise.race()` does not cancel the underlying operation. BullMQ `jobId` reduces duplicates only while that job exists; DB idempotency remains essential.
10. **Observability:** record intent age, backlog, delivery failures, attempts, stuck leases, dead-letter counts, and correlation identifiers without leaking personal data.

## Required regression scenarios

- Purchase DB transaction succeeds while Redis cannot accept a job.
- Broker accepts a job but acknowledgement times out; sender retries.
- Two application instances attempt to claim one intent concurrently.
- Owner crashes with a claimed intent; lease expires, another worker recovers.
- Old owner wakes after a newer lease was claimed; its update is rejected by fencing.
- Malformed/poison event is quarantined; transient outage retries according to policy.
- Replayed purchase/event cannot double award points or achievement rewards.
- Outbox status update fails after broker accepted the job.
- PostgreSQL transaction rollback leaves no ledger/dedupe/intent partial side effects.

Use real PostgreSQL integration tests for locking, lease/claim, and transactional behavior. Mock broker adapters if appropriate but make timeout and late completion behavior explicit.

## Operational questions

Document exactly what is acknowledged: queued, processed, or published to external consumers. Define repair/replay permissions and how operator detects dropped/stuck events. Never promise exactly-once cross-system execution.

## Inbound purchase and DOB delivery

`inbound_deliveries` is the PostgreSQL attempt journal and durable quarantine; it is not the outgoing RabbitMQ outbox. No queue redeclaration, DLX policy or queue-type change is required. Original messages remain unacknowledged until either the business callback commits successfully or the full original envelope and AMQP properties have been saved in quarantine. Extra monolith metadata remains accepted, but is never included in consumer diagnostics.

- An exact body and source queue identify one transport delivery budget (SHA-256). Business purchase deduplication still uses the existing event ID under the profile lock. Re-serializing an envelope changes the transport hash, not the business event ID.
- DOB is a setter with optional event identifiers: after a successful cycle, a new delivery of the same body can run again (A → B → A remains supported). Only successful DOB cycles may start a new budget; failures/exhaustion never reset on restart or ordinary redelivery. Birthday grants still use persistent domain deduplication. This does not impose new ordering guarantees on DOB events.
- Attempts are admitted atomically before execution and survive restarts. A crash consumes an attempt. PostgreSQL time governs the lease, backoff and fencing. A late owner cannot overwrite a newer attempt's state. A known successful business commit permits ACK even if the transport lease expired; the business dedupe handles duplicate concurrent callbacks.
- Invalid DTO/domain input and nonrepresentable integer accounting values are permanent. Recognized transient infrastructure errors and unknown failures retry within the same finite budget. No monetary cap, clamping or rounding of an overflowing total is introduced.
- Default settings: `RMQ_MAX_ATTEMPTS=3`, `RMQ_PREFETCH=5`, `RMQ_RETRY_BASE_MS=1000`, `RMQ_RETRY_MAX_MS=30000`, `RMQ_DELIVERY_LEASE_MS=30000`. Backoff doubles to the cap. The configured maximum attempts is captured on first admission; changing configuration does not reset existing budgets.
- While PostgreSQL/quarantine is unavailable, the original remains unacked and the handler pauses with bounded exponential backoff. Finite prefetch applies backpressure; this deliberately reduces throughput during an outage instead of dropping or rapidly requeueing financial events. Process/channel shutdown returns unacked messages to RabbitMQ. There is no dependency on a broker delivery counter.
- Quarantine is terminal until operator replay. Monitor `quarantine_required`, `quarantined_at`, attempts, age and `DELIVERY_STORE_UNAVAILABLE` diagnostics. Terminal rows and completed hashes are retained; automatic retention/deletion is not implemented. Plan growth/retention explicitly without deleting unresolved attempt budgets.
- Quarantine bytes can contain personal data. Restrict database/tool access, backup access and retention. Logs contain only allowlisted IDs, operation, delivery hash, static error code and attempt; they are not a copy of the payload.

### Rollout and controlled replay

1. Stop **all old source consumers** before enabling the new policy; old instances still nack/requeue without this budget. Keep the existing durable source queue and policies intact. No production broker type, policy, TLS, ACL or durability configuration is inferred from local tests.
2. Apply additive migration `20261021010000_inbound_delivery_budget` with `bun x prisma migrate deploy`, generate/build, then start only upgraded instances. The migration creates a new table and index; it does not scan existing financial tables or replay old data. Unacked messages redeliver normally. Verify actual prefetch, queue durability and effective policies in the target environment.
3. Investigate a quarantined row using restricted database access. Correct the underlying code/configuration/domain cause before replay. Do not edit its original body, financial ledger, event ID or dedupe rows. Invalid input requiring a corrected event must be reconciled with its producer rather than silently rewritten by this tool.
4. Stop **all consumers of the source queue**, including autoscaling/restarts, and keep them stopped throughout replay. The CLI checks consumer count twice, but this is an operational precondition, not a distributed deployment lock.
5. From the deployed **Node.js 22** build and service configuration, run:

   ```sh
   node dist/tools/replay-quarantine.js --delivery-id <sha256> --replay-id <new-uuid> --consumers-stopped
   ```

   Keep that replay UUID. A new UUID permits one explicitly approved budget reset. If publication fails or its result is ambiguous, rerun with the **same UUID**: it republishes without resetting the budget again. The original stored bytes remain available. Do not introduce another UUID just to bypass exhaustion.
6. Publication is persistent, mandatory and publisher-confirmed; returned/unroutable messages fail even if confirmed. A timeout does not prove absence of delivery. Consumer restart is safe only after confirming/repairing the replay publication. The original envelope and event ID are unchanged; AMQP user ID and expiration are retained as `x-loyalty-original-*` metadata rather than impersonating a broker user or expiring a financial replay. Other supported message properties are preserved. V8 property blobs are service-generated; use the deployed Node runtime, never untrusted files.
7. Resume upgraded consumers and verify business dedupe, terminal state and backlog. A crash between confirmed publish and operator confirmation can duplicate delivery; the model remains **at least once**. Quarantined messages never loop back automatically.

`bun run test:rmq` uses disposable, resource-limited PostgreSQL and RabbitMQ with real delivery/ACK/redelivery and separate worker processes. It requires Docker but no monolith checkout. `bun run test:transports` separately checks the unchanged monolith envelope and checkout integration against a pinned backend checkout.
