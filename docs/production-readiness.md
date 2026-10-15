# Production-readiness checklist — Cinema Loyalty Service

**Status: NOT CERTIFIED.** This is a review checklist, not a claim of production readiness. Each row needs evidence from CI, staging, operations or configuration. Verify the current working tree and deployment target; the observations below reflect the inspected GitHub branch on 2026-10-15 and may be stale.

## Release gates

- [ ] CI lint, build, unit/regression, PostgreSQL integration, and contract/proto checks complete on the exact commit being deployed.
- [ ] Branch protection requires passing checks; production deploy cannot bypass release gates by direct push.
- [ ] Image has reproducible, immutable version/digest and can be rolled back.
- [ ] Runtime config and secrets are validated at startup; no secrets printed by CI or application logs.
- [ ] Deploy applies/reviews Prisma 7 migrations safely, before incompatible code is activated. Have a database backup/restore plan and expand/contract migration strategy for breaking schema changes.
- [ ] Automated health/readiness checks verify process and critical dependencies; post-deploy smoke tests verify a real representative operation.
- [ ] Graceful shutdown drains consumers/workers and does not lose unacknowledged work.
- [ ] Centralized JSON/log correlation and actionable metrics/alerts are configured, with sensitive data minimized.
- [ ] TLS/network policies/least-privilege credentials are applied to HTTP/gRPC/RabbitMQ/PostgreSQL/Redis.
- [ ] Idempotency/retries/outbox/lease recovery proven with concurrency and injected failure tests.
- [ ] Backup restoration, incident response, replay, and rollback procedures have been rehearsed in staging.
- [ ] Load/soak tests cover expected throughput, queue backlog, and DB lock contention; document capacity and alert thresholds.

## Concrete inspection targets (2026-10-15 branch)

1. `src/main.ts`: `app.enableCors(getCorsConfig(...))` is followed later by `app.enableCors()` with no options. Review effective HTTP behavior and avoid accidental permissive CORS; add an HTTP integration check.
2. `src/app.controller.ts`: the inspected controller has no health endpoint. Verify whether another route/sidecar provides liveness/readiness; otherwise add one intentionally.
3. `.github/workflows/deploy.yml`: visible workflow cleans `/root/cinema-platform/loyalty`, SCPs the workspace, and runs `docker compose up -d --build`. Review atomicity, smoke testing, rollback, pinned versions, and release artifact promotion.
4. `.github/workflows/deploy.yml`: explicit `prisma migrate deploy` / migration job and health-gated promotion are not visible in the checked workflow. Verify whether the platform's surrounding compose/scripts handle them before declaring a defect.
5. `.github/workflows/deploy.yml`: debugging includes SSH `StrictHostKeyChecking=no` and key/network diagnostics. Replace with verified host-key handling and minimize production debug steps; review secret exposure risk.
6. `.github/workflows/ci.yml`: PR checks already include lint, build, Jest and PostgreSQL integration. Preserve this existing coverage; do not recreate it under new tool names.
7. `src/loyalty/consumers/ticket-purchased.consumer.ts`: raw incoming event payload is logged; review PII exposure and requeue policy during persistent transient outages.
8. `src/loyalty/outbox-publisher.service.ts`: tier outbox already uses atomic PostgreSQL claim with `FOR UPDATE SKIP LOCKED`. Review recovery of stale `PROCESSING` rows after worker or host crashes.
9. Planned `AchievementIntentPublisher`: verify actual remote/local existence, durable creation, multi-instance claim, timeout ambiguity, replay and deduplication before asserting fixes.

## Suggested evidence table

| Gate | Evidence / test command | Owner | Status |
| --- | --- | --- | --- |
| Functional CI | GitHub Actions URL + commit SHA | TBD | Not checked |
| Concurrent DB safety | PostgreSQL integration run | TBD | Not checked |
| Outbox recovery | crash/lease/retry integration tests | TBD | Not checked |
| Deployment health | staging smoke test | TBD | Not checked |
| Security | threat review + secret scan | TBD | Not checked |
| Backup restore | rehearsal date and logs | TBD | Not checked |

Do not mark a gate complete based on documentation or passing unit tests alone. Evidence should be reproducible.
