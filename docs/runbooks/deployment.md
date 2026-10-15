# Deployment and incident runbook (draft)

**Draft — do not use as a live production procedure before infrastructure review.** The repository deploy workflow invokes Docker Compose from a parent deployment workspace, so inspect that external Compose configuration before finalizing commands.

## Pre-deploy

1. Identify target environment, exact commit and image digest; verify no uncommitted changes in the artifact.
2. Confirm CI is green (lint, build, unit, integration, proto/contract where applicable).
3. Inspect proposed migration SQL for destructive operations, lock time and backward compatibility; confirm recent DB backup and rollback strategy.
4. Check queue backlog, error rate, database performance and available capacity.
5. Confirm required secrets/configuration are available without printing values.

## Deployment

1. Prefer building once and promoting an immutable artifact rather than compiling directly during remote deployment.
2. Apply reviewed, compatible migrations with the pinned Prisma 7 CLI via a one-off deploy job, not a development/reset command.
3. Deploy with orderly readiness checks and controlled traffic/worker activation.
4. Run automated smoke tests for health, DB connectivity and a representative non-destructive gRPC/HTTP or event operation.
5. Watch error rate, consumer failures, queue backlog, lock contention and unusual lag for an agreed monitoring window.

## If deployment fails

- Stop promotion/route traffic to last known healthy version when safe.
- Avoid blind DB down-migrations; use expand/contract and forward fixes if old code cannot read newly migrated data.
- Diagnose whether publisher intents are stuck (PROCESSING/lease expired), missing, or repeatedly failing; do not delete pending records to clear alerts.
- Reconcile ambiguous broker publish outcomes using durable event IDs and downstream idempotency.
- Escalate with trace/event identifiers, commit/image version, relevant timestamps and sanitized logs.

## Required operational metrics

- HTTP/gRPC error rate and p95/p99 latency.
- PostgreSQL connections, long transactions, deadlocks and profile lock wait time.
- RabbitMQ redelivery/unacked/backlog and consumer error rate.
- BullMQ job failures, retries, age and queue latency.
- Outbox pending count, oldest intent age, attempts, terminal failures and expired lease count.

## Ownership and links (fill before launch)

- Production environment URL: TBD
- Monitoring dashboards: TBD
- Alert destination and on-call owner: TBD
- Backup / restore procedure: TBD
- Deployment approval / rollback owner: TBD
- Consumer replay procedure: TBD
