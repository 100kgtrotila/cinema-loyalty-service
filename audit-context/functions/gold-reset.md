## `goldReset` — src/loyalty/loyalty-expiration.service.ts L206–240

**Purpose:** Очистити позначку GOLD-квоти. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Trusted optional progress callback. Calendar задає scheduler producer L46–53; функція month/timezone не приймає. Unique UUID id — schema L18.

**Outputs & Effects:** goldUpgradeUsedMonth=null + updatedAt; ledger/outbox немає L226–231.

---

**Block-by-Block:**

```typescript
// L215–224
...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
goldUpgradeUsedMonth: { not: null },
// take500, id desc
lastSeenId = batch[batch.length - 1]?.id;
```
Boundary перед mutation не потребує cursor row у filter. L226–231: один updateMany за ids, не повторює filter; standard PG row locks, explicit profile helper не викликається. L233–235: candidate total/progress після update.

---

**Cross-Function Dependencies:** Queue processor L45–49 передає job.updateProgress. Batch test L185–192 описує501 кандидат та excluded profile. Запуску не було.

**Open Questions:** Snapshot concurrent quota changes: `nothing found`; функція встановлює UPDATE serialization, не calendar barrier. Поведінка GOLD під час month reset — зовнішня business межа.
