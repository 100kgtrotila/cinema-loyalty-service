## `main` — test/fixtures/outbox-publisher-worker.cjs L15–48

**Purpose:** Справжній publisher в окремому Node процесі для kill/restart scenario. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Test env; URL guard localhost127.0.0.1/database loyalty_integration/user loyalty_test L16–24. Broker — контрольований emitter; IPC optional. Fixture config timeout60s/lease120s/concurrency2 L25–32.

**Outputs & Effects:** Реальні PostgreSQL claims/completion; IPC publishing/done, Prisma lifecycle.

---

**Block-by-Block:**

```javascript
// L35–38
emitter.on('loyalty.tier_upgraded', async () => {
  process.send?.({ type: 'publishing' });
  if (process.env.OUTBOX_WORKER_MODE === 'hold') await new Promise(() => {});
});
```
Signal означає delivery після claim. Hold дає parent точку SIGKILL. L39–43 connect→справжній publisher tick→done. L44–47 finally disconnect на звичайному unwind, не SIGKILL. Top-level catch L49–53 встановлює failure exit code.

---

**Cross-Function Dependencies:** Parent test IPC spawn L121–163, scenario L165–184 перевіряє PROCESSING, kill, force-expire lease та нові processes для recovery/delivery. Це не лише private-method invocation.

**Open Questions:** Real broker acceptance не перевіряється цією fixture; окремий transport suite має іншу межу. Tests не запускалися.
