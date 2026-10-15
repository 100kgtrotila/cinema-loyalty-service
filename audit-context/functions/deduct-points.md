## `deductPoints` — src/loyalty/loyalty.service.ts L113–204

**Purpose:** Списує бали та зберігає результат для повтору після втраченої відповіді. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Controller L48–55 передає user/order/amount/key; guard на controller L19 автентифікує сервіс. Helper schema L5–21 перевіряє UUID, positive int32, key1..128, нормалізує UUID lowercase. PK `processed_events.event_id` встановлює global uniqueness (schema L45). Перевірка бізнес-власності user/order тут: `nothing found`.

**Outputs & Effects:** success/balanceAfter/errorMessage. Нове списання atomic: balance/lastActivityAt, BURN_DISCOUNT ledger і request/result L165–188. Replay — історичний balance, не актуальний.

---

**Block-by-Block:**

```typescript
// L134–137
const result = await withTransactionRetry(this.prisma, async (trx) => {
  const profileLocked = await lockLoyaltyProfile(trx, command.userId);
  const replay = await replayPointCommand(trx, command);
  if (replay) return replay;
```
Lock перед dedupe встановлює спільний порядок. Replay можливий навіть без поточного профілю. Невалідний input повертає false/0 до DB L119–131. Після replay: minimum75, profile існування, sufficiency L138–163. Business refusals не резервують key; missing profile кидає NOT_FOUND.

L165–167: new balance та claim перед змінами. Global key collision може повернути raced replay/conflict. L169–186: profile та ledger на тому самому trx; rollback видаляє і claim. L192–202: RpcException поширюється; інші errors → logged internal failure.

---

**Cross-Function Dependencies:** `parsePointCommand`, `replayPointCommand`, `claimPointCommand` helper L19–84; READ COMMITTED/retry і lock без create у profile-transaction L9–78. CHECK міграції допускає повний result або all-null legacy L10–17.

**Open Questions:** Де caller доводить user/order ownership? Який retention idempotency records? Tests L139–308 integration прочитані, не запускалися.
