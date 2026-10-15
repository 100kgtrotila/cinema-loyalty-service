## `parsePointCommand` — src/loyalty/point-command-idempotency.ts L19–22

**Purpose:** Runtime input → валідована command або null. Аналіз function_b, запис координатора.

**Inputs & Assumptions:** Статичний PointCommand містить неперевірені gRPC значення від callers service L119–125 / expiration L248–254. TypeScript не є runtime validation.

**Outputs & Effects:** Parsed normalized data/null; DB/мережі немає.

---

**Block-by-Block:**

```typescript
const parsed = PointCommandSchema.safeParse(input); // L20
return parsed.success ? parsed.data : null; // L21
```
Zod schema L5–11 встановлює operation enum, UUID user/order lowercase, amount positive integer<=2147483647, opaque key1..128. Це передує DB callers та визначає representation для comparison/claim. Opaque key не lower-case/trim-иться.

---

**Cross-Function Dependencies:** Zod safeParse — зовнішній validation contract. Callers відмовляють до транзакції. Існування user/order і право операції schema не встановлює: `nothing found` у цій функції.

**Open Questions:** Semantic user/order authorization визначається caller contract, а не syntax validation. Tests не запускалися.
