# Achievement intents та перевірка інтеграції

## Версії й baseline

Перевірка 2026-10-15:

| Репозиторій | HEAD |
| --- | --- |
| cinema-loyalty-service | `12c8ad01a25246ae19ba8ad045a052a3a92b8023` + зміни цього етапу |
| cinema-platform-back | `86ab48aacbf9ec1b58246e5a67ec524ad3d787d9` |

Обидва working tree були чисті перед початком. Tracked-файли моноліту не змінені. Baseline: build, 12 Jest unit/regression tests, 27 PostgreSQL integration tests проходили; lint мав лише попередження `no-floating-promises` у `main.ts`. Bun 1.3.13, `bun.lock`, Jest і Node.js 22 application runtime збережені; залежності не оновлювалися.

## Дефект і реалізація

До цього етапу purchase комітив profile/ledger/processed event, а потім викликав `dispatchEvent`. Помилка Redis після commit залишала покупку без achievement jobs; повтор RabbitMQ повідомлення пропускався через processed event. Цей шлях виявлено читанням коду. Відтворення подвійного успішного списання до concurrency fix описано в [profile-concurrency.md](profile-concurrency.md).

За погодженням користувача durable dispatch включено до поточного етапу:

- Нова таблиця `achievement_dispatch_intents`, unique `(user_id, event_id, action_type)`.
- Purchase записує `TICKET_PURCHASED` і, за наявного правила `seatClass === 'VIP'`, `VIP_SEAT_BOUGHT` одним transaction client разом із profile, ledger, purchase dedupe та tier outbox. Event IDs та metadata збережені; відсутні optional metadata не записуються як `undefined`.
- Publisher читає до 50 pending intents кожні 5 секунд; перекриття cron в одному процесі вимкнене. Немає транзакцій чи profile locks під час Redis-викликів.
- BullMQ `jobId` — UUID intent. Успішний enqueue позначає `delivered_at`; збій залишає intent pending, записує помилку/attempts і відкладає нову спробу на 5 секунд. Використовується наявний `OUTBOX_PUBLISH_TIMEOUT_MS` (типово 10000). Redis outage не має ліміту спроб publisher-а.
- Якщо enqueue прийнятий, але DB update не вдався, intent повторюється з тим самим job ID. Кілька publisher replicas можуть публікувати один intent; ефект у worker додатково захищений чинним PostgreSQL dedupe `${eventId}_${achievementId}` під profile lock.
- Немає стану `PROCESSING` або lease у новій таблиці: crash до позначки delivery залишає запис доступним для повтору. Наявний RabbitMQ outbox не перероблявся.

Перед запуском оновленого застосунку потрібні `bun x prisma migrate deploy`, `bun x prisma generate` і build. Міграція лише додає таблицю та індекси; старі міграції не змінені. Автоматичного backfill старих покупок немає.

## Відтворюваний стенд

```bash
bun install --frozen-lockfile
bun x prisma generate
bun run test:integration
bun run test:transports
```

`test/run-transports.mjs` читає наявний Compose моноліту й накладає `test/e2e/compose.override.yml`. До запуску перевіряються resolved ports і mounts. Кожний запуск має окреме project name, random localhost ports, окремі PostgreSQL 16 бази без постійних DB volumes і власні RabbitMQ/Redis. Вимоги: Docker Engine, Compose 2.24.4+ (`!override`), BuildKit named contexts, сусідній checkout моноліту. Локальний .NET SDK не потрібен.

Моноліт збирається й тестується в .NET 10 контейнері. Запускаються його наявні `OrderCheckoutCharacterizationTests`; застосовуються наявні EF migrations через `Cinema.DbUpdater`. Seeder із writable source mount вимкнено. Тест створює ізольовані user/session/seats/achievement дані. JWT підписаний локальним тестовим ключем, використовуються чинні authentication та API guards. Payment — наявний `MockPaymentService` моноліту; зовнішні payment, email, TMDB та Gemini не використовуються.

Redis моноліту для seat locks та Redis loyalty для BullMQ розділені. Це дозволяє перевірити саме недоступність loyalty Redis: outage спільного Redis додатково заблокував би checkout у моноліті, до отримання loyalty події.

Runner очищує тільки свій Compose project у `finally`. Версії — `.tmp/transports-versions.json`, Jest results — `.tmp/transports-results.json`; при помилці логи — `.tmp/transports-logs.txt`. Звіт попереднього запуску видаляється перед новим.

## Перевірені сценарії

### Наскрізно: 4 Jest transport tests

| Сценарій | Що перевіряється |
| --- | --- |
| HTTP покупка зі списанням | Реальні preview/deduct gRPC, оплачений order, ledger `BURN_DISCOUNT=-200` з початкових 500, purchase через RabbitMQ, один intent, progress=1, balance=300; за використання балів нові purchase points не нараховуються |
| Loyalty Redis зупинено | Друга HTTP покупка за 400 проходить, purchase/intent збережені, failed delivery залишається pending; balance=700, lifetime/yearPoints=400, visits=2 |
| Redis відновлено | Loyalty процес зупиняється й запускається знову, тому відновлення спирається на DB intent; jobs оброблені, progress=2, одна винагорода 30, balance=730, lifetime=430, yearPoints=400; обидва intents delivered |
| Повтор TicketPurchased | Повідомлення повторно надсилається через RabbitMQ confirm channel; management API підтверджує ack і порожню чергу; profile, ledger, progress і кількість intents не змінюються, reward залишається один |

Перший пробний запуск виявив неправильну секцію API key у тестовому override: `LoyaltySettings.SectionName` моноліту дорівнює `InternalServices`. Override виправлено на `InternalServices__ApiKey`; production код моноліту не змінювався.

### Незалежно: 31 PostgreSQL integration test

27 concurrency сценаріїв залишилися успішними: усі обов'язкові пари writer-ів, stale expiry, сума expiry ledger, rollback, dedupe, tier/birthday/reset, конкурентне створення профілю та обмежений transaction retry. Перекриття writer-ів підтверджується через `pg_stat_activity`, а не лише `Promise.all`.

Додані 4 тести: atomic purchase/VIP intents при offline queue; rollback profile/ledger/outbox/dedupe при PostgreSQL trigger failure на intent INSERT; повтор доставки після Redis failure та DB failure після queue acceptance з тим самим job ID; enqueue timeout без неправдивої delivery позначки. PostgreSQL/Prisma справжні, BullMQ adapter у цих незалежних тестах замінено контрольованим adapter-ом. Реальні transports перевіряє окремий suite вище.

Додатково: 12 unit/regression tests, build і lint проходять (лише baseline warning). Віддалений GitHub CI не запускався; його integration gate включає нові тести. `test:transports` потребує другого репозиторію й не доданий до PR CI.

## Пропозиції власнику моноліту

1. Явні RPC deadlines та обмежений transient retry зі сталими deduct/refund keys. Поточний cancellation/timeout після loyalty commit може залишити списання для failed order. Потрібна окрема політика відновлення неоднозначного результату до compensation.
2. Durable reconciliation невдалих compensation: зараз помилка refund лише логується; відновлення має працювати незалежно від скасованого request token.
3. Якщо потрібні VIP achievements із реальних checkout, узгодити передачу `seatClass`: поточний `NestJsTicketPurchasedEnvelope` його не передає. Loyalty зберігає попереднє правило; VIP intent перевірений незалежним тестом, а не HTTP checkout.

## Неперевірене та залишкові ризики

- Не перевірені наскрізно реальний payment provider, network timeout після deduct commit, refund compensation failure, багаторепліковий publisher, довге навантаження та outage спільного Redis моноліту.
- `delivered_at` означає прийняття Redis, не завершення job. Втрата Redis data після enqueue/позначки потребує окремих Redis persistence/HA і reconciliation рішень. BullMQ має чинні 3 worker attempts; вичерпані failed jobs потребують операційного replay.
- Timeout не скасовує вже запущену Redis-команду. Повтор із сталим job ID та worker DB dedupe захищають ефект; це доставка щонайменше один раз.
- Delivered intents, processed events і failed jobs потребують окремої retention/monitoring політики. Історичні пропущені achievement events потребують контрольованого backfill.
- Залишаються окремими задачами RabbitMQ outbox lease recovery, межі існуючої idempotency/refund/GOLD, calendar-year boundary та contention latency. Durable achievement dispatch як наступний крок попереднього етапу реалізовано мінімально; далі — операційне відновлення та спостереження за доставкою. Цей етап не встановлює повну production readiness.
