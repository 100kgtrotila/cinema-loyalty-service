# Cinema Loyalty Service

Cinema Loyalty Service is a NestJS microservice for the Cinema Platform loyalty domain. It manages loyalty points, customer tiers, GOLD seat upgrades, birthday bonuses, achievements, gRPC integration with the main .NET backend, RabbitMQ events, and BullMQ background jobs.

## Tech Stack

- **NestJS 11** for the application layer and microservices.
- **PostgreSQL + Prisma 7** for loyalty profiles, transactions, achievements, and outbox events.
- **gRPC + Protocol Buffers** for synchronous integration with `cinema-platform-back`.
- **RabbitMQ** for ticket purchase and user profile events.
- **Redis + BullMQ** for scheduled and asynchronous background jobs.
- **Zod** for achievement criteria and event payload validation.
- **class-validator** for incoming RabbitMQ/gRPC DTO validation.

## What The Service Does

### Loyalty

- Creates a loyalty profile on the first user interaction.
- Stores `balance`, `lifetimePoints`, `yearPoints`, `yearVisits`, and `tier`.
- Supports `BRONZE`, `SILVER`, and `GOLD` tiers.
- Awards points for ticket purchases when the user did not use existing points for that purchase.
- Calculates a discount preview through the gRPC `CalculateDiscount` method.
- Deducts points through `DeductPoints` with an idempotency key.
- Refunds points through `RefundPoints` when the checkout/payment flow needs compensation.
- Allows GOLD users to use one seat upgrade per month.
- Grants a birthday bonus once per year.
- Stores the full points history in `points_transactions`.

### Achievements

- Stores achievements with categories, rarity, strategy, and JSON criteria.
- Validates achievement criteria with Zod schemas.
- Processes achievement events asynchronously through BullMQ.
- Updates progress in `user_achievements`.
- Unlocks achievements and grants reward points.
- Prevents duplicate processing with `processed_events`.

### Reliability

- Events that must be published externally are stored in `outbox_events`.
- `OutboxPublisherService` publishes pending events to RabbitMQ.
- Balance-changing operations run inside Prisma transactions.
- Idempotency is used for point deduction, ticket purchase events, and achievement events.

## Business Rules

### Earning Points For Ticket Purchases

A `TicketPurchased` event may include:

```json
{
  "totalAmount": 500,
  "ticketAmount": 500,
  "paidAmount": 200,
  "pointsUsed": 300
}
```

If `pointsUsed > 0`, the service **does not award new points** for that purchase. The visit is still counted in `yearVisits`, and achievement events still receive `paidAmount` and `pointsUsed` metadata.

If `pointsUsed` is not present in the payload, the service checks `points_transactions` by `orderId` and looks for a `BURN_DISCOUNT` transaction.

### Discount Preview

The service exposes the gRPC `CalculateDiscount` method. The .NET monolith uses it so the frontend can show, before checkout:

- how many points will be deducted;
- how much the user will still need to pay;
- whether loyalty point payment is available.

Rules:

- minimum deduction: `75` points;
- maximum discount: `50%` of the order amount;
- 1 point equals 1 currency unit in the discount calculation.

### Birthday Bonus

- The birthday date is stored as a date-only value.
- Birthday comparisons use UTC local date semantics.
- Bonus amount: `100` points.
- The `user_bonus_grants` table guarantees that a birthday bonus can be granted only once per UTC year.

### GOLD Upgrade

- Available only for `GOLD` users.
- Can be used once per month.
- Usage is stored in `gold_upgrade_used_month`.
- The `gold-reset` job clears the monthly quota at the beginning of a new month.

## Integration Architecture

```text
cinema-platform-back
  | gRPC
  v
cinema-loyalty-service
  | Prisma
  v
PostgreSQL

cinema-platform-back
  | RabbitMQ: loyalty_ticket_purchased
  v
TicketPurchasedConsumer
  -> LoyaltyService.processTicketPurchase()
  -> AchievementsService.dispatchEvent()
  -> BullMQ achievements-queue

BullMQ loyalty-queue
  -> expire-points
  -> notify-expiring
  -> annual-stats-reset
  -> gold-reset
  -> grant-birthday-bonuses
```

## gRPC API

Proto file: `src/proto/loyalty/v1/loyalty.proto`.

Main `LoyaltyService` methods:

- `GetBalance`
- `GetFullProfile`
- `GetTransactions`
- `CalculateDiscount`
- `DeductPoints`
- `RefundPoints`
- `UseGoldUpgrade`
- `RollbackGoldUpgrade`
- `GetAdminUserBalance`
- `GetAdminTransactionHistory`
- `ModifyUserPoints`
- `GetAdminUsers`
- `GrantVipStatus`

Main `AchievementsService` methods:

- `CreateAchievement`
- `UpdateAchievement`
- `DeleteAchievement`
- `GetAdminAchievements`
- `GetUserAchievements`

Internal/admin gRPC calls are protected with metadata API key:

```text
x-api-key: <INTERNAL_API_KEY>
```

## RabbitMQ

The service connects an RMQ microservice and listens to:

```text
RMQ_QUEUE=loyalty_ticket_purchased
```

It also publishes loyalty domain events to:

```text
RMQ_LOYALTY_EVENTS_QUEUE=loyalty.events
```

Events:

- `TicketPurchased` - handles ticket purchase processing.
- user date of birth event - stores birthday date and may grant the birthday bonus.
- `loyalty.tier_upgraded` - emitted when a user moves to a higher tier.
- `loyalty.points_expiring` - emitted when users should be notified about points expiring soon.

## BullMQ Jobs

Queue names:

```text
loyalty-queue
achievements-queue
```

Loyalty jobs:

| Job | Schedule | What it does |
| --- | --- | --- |
| `expire-points` | every day at 03:00 | expires outdated points |
| `notify-expiring` | every day at 04:00 | marks users who should be notified about soon-to-expire points |
| `annual-stats-reset` | January 1 at 00:05 | resets `yearPoints` and `yearVisits` |
| `gold-reset` | first day of every month at 01:00 | clears `goldUpgradeUsedMonth` |
| `grant-birthday-bonuses` | every day at 00:10 UTC | grants birthday bonuses |

Achievement jobs:

| Job | Queue | What it does |
| --- | --- | --- |
| `process-achievement` | `achievements-queue` | validates an action event, updates progress, unlocks an achievement, and grants reward points |

In Redis Insight, search for:

```text
bull:loyalty-queue:*
bull:achievements-queue:*
```

## Project Structure

```text
src/
  achievements/
    constants/       achievement constants
    enums/           categories, actions, maps
    helpers/         progress calculation
    interfaces/      contracts for the achievements module
    mappers/         gRPC/domain mapping
    processors/      BullMQ achievement worker
    schemas/         Zod schemas
    validators/      validation services
  common/            shared gRPC status helpers
  config/            app, BullMQ, RabbitMQ, and CORS config
  generated/prisma/  generated Prisma client
  guards/            gRPC API key guard
  loyalty/
    consumers/       RabbitMQ consumers
    constants/       loyalty rules, queues, and cron expressions
    dto/             RabbitMQ DTOs
    events/          internal event enums/classes
    processors/      BullMQ loyalty worker
    producers/       scheduled job producer
    utils/           UTC local date utilities
  prisma/            Prisma module/service
  proto/             gRPC proto files
  utils/             shared mappers
prisma/              schema and migrations
```

## Requirements

- Node.js 22+ recommended.
- npm.
- PostgreSQL.
- Redis.
- RabbitMQ.
- Prisma CLI through `npx prisma`.
- Buf CLI if proto lint/build checks are needed.

## Environment

Example `.env`:

```env
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:5173

GRPC_URL=0.0.0.0:50051
INTERNAL_API_KEY=change-me

DATABASE_URL=postgresql://postgres:postgres@localhost:5433/cinema_loyalty_db?schema=public

RMQ_URL=amqp://guest:guest@localhost:5672
RMQ_QUEUE=loyalty_ticket_purchased
RMQ_LOYALTY_EVENTS_QUEUE=loyalty.events

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=redis_password

JWT_SECRET=change-me
```

## Local Setup

Install dependencies:

```bash
npm install
```

Generate the Prisma client:

```bash
npx prisma generate
```

Apply migrations:

```bash
npx prisma migrate deploy
```

For local development with new migrations:

```bash
npx prisma migrate dev
```

Validate proto files:

```bash
npm run buf:lint
npm run buf:build
```

Run the development server:

```bash
npm run start:dev
```

Production build:

```bash
npm run build
npm run start:prod
```

After startup, the service runs:

- HTTP server on `PORT`;
- gRPC microservice on `GRPC_URL`;
- RabbitMQ microservice on `RMQ_QUEUE`;
- BullMQ workers for `loyalty-queue` and `achievements-queue`.

## Scripts

```bash
npm run build
npm run start
npm run start:dev
npm run start:prod
npm run lint
npm run test
npm run test:cov
npm run test:e2e
npm run buf:lint
npm run buf:build
```

## Useful SQL Checks

Loyalty profiles:

```sql
select user_id, tier, balance, lifetime_points, year_points, year_visits,
       balance_expires_at, last_expiry_notification_at, gold_upgrade_used_month
from loyalty_profiles
order by user_id;
```

Transactions:

```sql
select user_id, type, points, balance_after, order_id, description, created_at
from points_transactions
order by created_at desc;
```

Birthday grants:

```sql
select user_id, type, grant_year, points, granted_at
from user_bonus_grants
order by granted_at desc;
```

Achievement progress:

```sql
select a.code, ua.current, ua.target, ua.is_unlocked, ua.unlocked_at
from user_achievements ua
join achievements a on a.id = ua.achievement_id
order by a.code;
```

## Troubleshooting

### Prisma Client Error

If you see:

```text
Cannot find module './internal/class.js'
```

regenerate the Prisma client and rebuild:

```bash
npx prisma generate
npm run build
```

### Proto File Not Found In dist

`main.ts` resolves the proto file from several possible locations:

- `src/proto/loyalty/v1/loyalty.proto`
- `dist/proto/loyalty/v1/loyalty.proto`
- a path relative to `dist/src/main`

If the service is started from a non-standard directory, check the current working directory and whether `src/proto` exists.

### Redis Insight Does Not Show Completed Jobs

Production scheduled jobs may use `removeOnComplete`, so completed jobs can disappear from Redis. If completed jobs must stay visible while debugging, enqueue jobs with:

```text
removeOnComplete=false
removeOnFail=false
```

### A Job Key Does Not Look Like `completed`

BullMQ stores a job itself as a hash:

```text
bull:loyalty-queue:<job-id>
```

State indexes are stored separately as sorted sets/lists:

```text
bull:loyalty-queue:delayed
bull:loyalty-queue:completed
bull:loyalty-queue:failed
```

If `completed` is not visible, search for `bull:loyalty-queue:*` and open a concrete job hash. It contains fields such as `name`, `data`, `timestamp`, `delay`, and `opts`.

## Related Documentation

- `src/proto/loyalty/v1/loyalty.proto` - gRPC API contract.
- `prisma/schema.prisma` - database model.

## License

Internal / UNLICENSED.
