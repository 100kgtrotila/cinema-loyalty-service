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
