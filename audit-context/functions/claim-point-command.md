## `claimPointCommand` — src/loyalty/point-command-idempotency.ts L62–84

**Purpose:** Зарезервувати global key із request/result у caller transaction або прочитати переможця гонки. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Переданий tx, normalized command, computed balanceAfter; callers уже взяли profile lock та business checks, але ще не записали effect (deduct L134–186; refund L262–295). Власної transaction немає.

**Outputs & Effects:** ProcessedEvent INSERT; undefined — новий claim, result — existing key. Caller rollback прибирає незакомічений claim.

---

**Block-by-Block:**

```typescript
// L68–79
const inserted = await tx.processedEvent.createMany({
  data: { /* key, operation, userId, orderId, amount, balanceAfter */ },
  skipDuplicates: true,
});
```
PK schema L45 серіалізує key conflict також між різними profiles. ON CONFLICT та READ COMMITTED visibility — PostgreSQL contract; локальний profile lock цього не встановлює. L80: count1 → caller mutation. L81–83: replay existing request; record disappeared → explicit throw. CHECK міграції встановлює completeness, не відповідність поточному balance.

---

**Cross-Function Dependencies:** replay L26–60 розрізняє exact/conflict/legacy. Atomicity result з effect залежить від переданого caller tx. Пошук src для production ProcessedEvent знайшов inserts helper/purchase/processor, не ORM update/delete.

**Open Questions:** DB-level immutable/retention захист від direct SQL: `nothing found`. Пошук service source не охоплює зовнішні адміністративні дії. Tests не запускалися.
