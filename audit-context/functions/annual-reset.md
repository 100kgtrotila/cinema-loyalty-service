## `resetAnnualStats` — src/loyalty/loyalty-expiration.service.ts L167–204

**Purpose:** Обнулити річні counters придатних профілів. Аналіз делеговано function_b; артефакт записав координатор із record.

**Inputs & Assumptions:** Optional довірений progress callback від queue processor L38–43. Calendar schedule встановлює scheduler producer L37–44; функція calendar barrier не встановлює. UUID PK/unique userId — schema L17–19.

**Outputs & Effects:** Лише yearPoints/yearVisits=0 L190–193; ledger/outbox не створюються. total — кількість прочитаних кандидатів, не affected-row count L197.

---

**Block-by-Block:**

```typescript
// L176–181,L185
...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
OR: [{ yearPoints: { gt: 0 } }, { yearVisits: { gt: 0 } }],
orderBy: { id: 'desc' },
lastSeenId = batch[batch.length - 1]?.id;
```
Фільтр і стабільний descending order визначають 500 кандидатів. Порожня batch завершує job L184. Збереження межі до обнулення дозволяє наступному запиту обходитися без cursor row, що покинув filter.

L187–195: одна READ COMMITTED transaction на профіль; lock userId перед updateMany candidate id. Відсутній профіль — return, updateMany без знайденого id не змінює рядків. Абсолютний запис стосується лише двох counters.

L197–203: candidate total, progress callback поза DB transaction, log. Помилки поширюються; попередні профілі вже commit-нуті.

---

**Cross-Function Dependencies:** `withTransactionRetry` L9–58 і `lockLoyaltyProfile` L63–78 у profile-transaction.ts встановлюють обмежені retries, profile-first lock без create. Штатний processor чекає завершення та передає job.updateProgress.

**Open Questions:** Snapshot довільних конкурентних insert/filter змін: `nothing found`. Стабільність candidate id при delete/recreate: `nothing found` поза PK у даний момент. Окремої семантики year-boundary function не задає. Читано batch tests L167–182, без запуску.
