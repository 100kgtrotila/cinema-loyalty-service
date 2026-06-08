# Cinema Loyalty Service

<p align="center">
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-7-2D3748?style=for-the-badge&logo=prisma&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Database-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" />
  <img alt="Redis" src="https://img.shields.io/badge/Redis-BullMQ-DC382D?style=for-the-badge&logo=redis&logoColor=white" />
  <img alt="RabbitMQ" src="https://img.shields.io/badge/RabbitMQ-Events-FF6600?style=for-the-badge&logo=rabbitmq&logoColor=white" />
  <img alt="gRPC" src="https://img.shields.io/badge/gRPC-Protobuf-244C5A?style=for-the-badge&logo=google&logoColor=white" />
</p>

<p align="center">
  Loyalty, achievements, points economy, GOLD seat upgrades, birthday bonuses, gRPC APIs, RabbitMQ consumers, and BullMQ background jobs for the Cinema Platform.
</p>

## Table Of Contents

- [Overview](#overview)
- [Core Capabilities](#core-capabilities)
- [Technology Matrix](#technology-matrix)
- [Architecture](#architecture)
- [Business Rules](#business-rules)
- [gRPC API](#grpc-api)
- [RabbitMQ Events](#rabbitmq-events)
- [BullMQ Jobs](#bullmq-jobs)
- [Project Structure](#project-structure)
- [Local Setup](#local-setup)
- [Scripts](#scripts)
- [Useful SQL Checks](#useful-sql-checks)
- [Troubleshooting](#troubleshooting)

## Overview

Cinema Loyalty Service is a NestJS microservice responsible for the loyalty domain in the Cinema Platform. It exposes internal gRPC APIs for the .NET monolith, consumes RabbitMQ events from the checkout flow, persists loyalty state in PostgreSQL, and runs scheduled or asynchronous workloads through BullMQ.

| Area | Responsibility |
| --- | --- |
| Loyalty profiles | Balance, lifetime points, yearly points, yearly visits, user tier |
| Points economy | Earn, deduct, refund, expire, adjust, and audit point transactions |
| Discount preview | Calculate how many points can be applied before checkout |
| GOLD benefits | One GOLD seat upgrade per user per month |
| Birthday rewards | One birthday bonus per UTC calendar year |
| Achievements | Criteria-based progress, unlocks, secret achievements, reward points |
| Reliability | Transactions, idempotency keys, processed events, transactional outbox |

## Core Capabilities

| Capability | Entry Point | Storage | Notes |
| --- | --- | --- | --- |
| Get loyalty balance | gRPC `GetBalance` | `loyalty_profiles` | Creates a profile if it does not exist |
| Full profile view | gRPC `GetFullProfile` | `loyalty_profiles` | Includes tier, expiry dates, birthday week, GOLD availability |
| Discount preview | gRPC `CalculateDiscount` | `loyalty_profiles` | Used by the .NET backend before checkout |
| Deduct points | gRPC `DeductPoints` | `points_transactions`, `processed_events` | Idempotent by `idempotency_key` |
| Refund points | gRPC `RefundPoints` | `points_transactions` | Used as checkout compensation |
| Ticket purchase processing | RabbitMQ `TicketPurchased` | `loyalty_profiles`, `points_transactions` | Awards points only when points were not redeemed |
| Achievement processing | BullMQ `achievements-queue` | `achievements`, `user_achievements` | Validates payload and criteria with Zod |
| Scheduled maintenance | BullMQ `loyalty-queue` | loyalty tables | Expiry, notifications, annual reset, GOLD reset, birthday bonuses |

## Technology Matrix

| Layer | Technology | Purpose |
| --- | --- | --- |
| Runtime | Node.js 22 | JavaScript runtime |
| Framework | NestJS 11 | Application modules, DI, microservices |
| Language | TypeScript 5.7 | Typed service implementation |
| Database | PostgreSQL | Durable loyalty and achievement state |
| ORM | Prisma 7 | Type-safe database access and migrations |
| Synchronous API | gRPC + Protobuf | Internal API consumed by `cinema-platform-back` |
| Event transport | RabbitMQ | Ticket purchase and loyalty domain events |
| Background jobs | BullMQ + Redis | Scheduled jobs and asynchronous achievement processing |
| Validation | Zod, class-validator | Runtime payload and criteria validation |
| Tests | Jest | Unit/e2e testing |
| Proto tooling | Buf | Proto lint/build validation |

## Architecture

### Service Context

```mermaid
flowchart LR
    Platform["cinema-platform-back<br/>.NET monolith"]
    Loyalty["cinema-loyalty-service<br/>NestJS"]
    Postgres[("PostgreSQL")]
    Rabbit["RabbitMQ"]
    Redis[("Redis")]
    Workers["BullMQ workers"]

    Platform -- "gRPC: balance, discount, deduct, refund" --> Loyalty
    Platform -- "RabbitMQ: TicketPurchased" --> Rabbit
    Rabbit --> Loyalty
    Loyalty --> Postgres
    Loyalty --> Redis
    Redis --> Workers
    Workers --> Postgres
```

### Ticket Purchase Flow

```mermaid
sequenceDiagram
    participant User
    participant Platform as cinema-platform-back
    participant Loyalty as loyalty-service
    participant Rabbit as RabbitMQ
    participant DB as PostgreSQL
    participant Jobs as BullMQ

    User->>Platform: Checkout request
    Platform->>Loyalty: CalculateDiscount(userId, orderAmount)
    Loyalty-->>Platform: pointsToDeduct, amountToPay
    Platform->>Loyalty: DeductPoints(...)
    Loyalty->>DB: BURN_DISCOUNT transaction
    Platform->>Rabbit: TicketPurchased event
    Rabbit->>Loyalty: consume TicketPurchased
    Loyalty->>DB: update visits/tier/points
    Loyalty->>Jobs: enqueue achievement events
    Jobs->>DB: update achievement progress
```

### Reliability Model

```mermaid
flowchart TD
    Event["Incoming event / gRPC command"]
    Validate["Validate DTO / schema"]
    Idempotency["Check processed_events or idempotency key"]
    Tx["Prisma transaction"]
    Outbox["outbox_events"]
    Publish["Outbox publisher -> RabbitMQ"]

    Event --> Validate --> Idempotency --> Tx
    Tx --> Outbox --> Publish
```

## Business Rules

### Points Earning

`TicketPurchased` may include both payment and redemption values:

```json
{
  "totalAmount": 500,
  "ticketAmount": 500,
  "paidAmount": 200,
  "pointsUsed": 300
}
```

| Condition | Result |
| --- | --- |
| `pointsUsed > 0` | No new points are awarded for this purchase |
| `pointsUsed = 0` or missing | Points are calculated from `paidAmount ?? totalAmount` |
| `pointsUsed` is missing | Service checks `BURN_DISCOUNT` transactions by `orderId` |
| Purchase already processed | Event is skipped through `processed_events` |

The visit is still counted in `yearVisits`, and achievements receive `paidAmount` and `pointsUsed` metadata.

### Discount Preview

| Rule | Value |
| --- | --- |
| Method | gRPC `CalculateDiscount` |
| Minimum deduction | `75` points |
| Maximum discount | `50%` of order amount |
| Conversion | `1 point = 1 currency unit` |
| Consumer | `.NET` monolith before checkout |

### Tier Rules

| Tier | Year Visits | Year Points | Multiplier |
| --- | ---: | ---: | ---: |
| `BRONZE` | default | default | `1.0x` |
| `SILVER` | `8+` | `2000+` | `1.5x` |
| `GOLD` | `20+` | `5000+` | `2.0x` |

### Birthday Bonus

| Rule | Value |
| --- | --- |
| Bonus amount | `100` points |
| Date logic | UTC local date semantics |
| Idempotency | unique `(userId, type, grantYear)` in `user_bonus_grants` |
| Scheduled job | `grant-birthday-bonuses` every day at `00:10 UTC` |

### GOLD Seat Upgrade

| Rule | Value |
| --- | --- |
| Eligible tier | `GOLD` |
| Limit | one upgrade per month |
| Usage field | `gold_upgrade_used_month` |
| Reset job | `gold-reset` on the first day of every month |

## gRPC API

Proto file: [`src/proto/loyalty/v1/loyalty.proto`](src/proto/loyalty/v1/loyalty.proto).

| Service | RPC | Purpose |
| --- | --- | --- |
| `LoyaltyService` | `GetBalance` | Get balance, lifetime points, yearly points, tier |
| `LoyaltyService` | `GetFullProfile` | Get full loyalty profile |
| `LoyaltyService` | `GetTransactions` | Get user transaction history |
| `LoyaltyService` | `CalculateDiscount` | Preview point deduction and amount to pay |
| `LoyaltyService` | `DeductPoints` | Deduct points for checkout |
| `LoyaltyService` | `RefundPoints` | Refund deducted points |
| `LoyaltyService` | `UseGoldUpgrade` | Reserve monthly GOLD upgrade |
| `LoyaltyService` | `RollbackGoldUpgrade` | Roll back GOLD upgrade reservation |
| `LoyaltyService` | `GetAdminUserBalance` | Admin balance lookup |
| `LoyaltyService` | `GetAdminTransactionHistory` | Admin transaction lookup |
| `LoyaltyService` | `ModifyUserPoints` | Admin manual points adjustment |
| `LoyaltyService` | `GetAdminUsers` | Admin loyalty users list |
| `LoyaltyService` | `GrantVipStatus` | Admin grant VIP/GOLD-like status |
| `AchievementsService` | `CreateAchievement` | Admin achievement creation |
| `AchievementsService` | `UpdateAchievement` | Admin achievement update |
| `AchievementsService` | `DeleteAchievement` | Admin achievement deletion |
| `AchievementsService` | `GetAdminAchievements` | Admin achievements list |
| `AchievementsService` | `GetUserAchievements` | User-facing achievement progress |

Internal/admin gRPC calls are protected with metadata:

```text
x-api-key: <INTERNAL_API_KEY>
```

## RabbitMQ Events

| Queue / Event | Direction | Handler | Purpose |
| --- | --- | --- | --- |
| `loyalty_ticket_purchased` | inbound | `TicketPurchasedConsumer` | Processes checkout completion |
| user date of birth event | inbound | DOB consumer | Stores birthday date and may grant birthday bonus |
| `loyalty.tier_upgraded` | outbound | outbox publisher | Notifies platform about tier upgrades |
| `loyalty.points_expiring` | outbound | outbox publisher | Notifies platform about soon-to-expire points |

## BullMQ Jobs

Queue names:

```text
loyalty-queue
achievements-queue
```

| Queue | Job | Schedule / Trigger | Purpose |
| --- | --- | --- | --- |
| `loyalty-queue` | `expire-points` | every day at `03:00` | Expires outdated points |
| `loyalty-queue` | `notify-expiring` | every day at `04:00` | Marks users for expiry notifications |
| `loyalty-queue` | `annual-stats-reset` | January 1 at `00:05` | Resets `yearPoints` and `yearVisits` |
| `loyalty-queue` | `gold-reset` | first day of every month at `01:00` | Clears monthly GOLD upgrade usage |
| `loyalty-queue` | `grant-birthday-bonuses` | every day at `00:10 UTC` | Grants birthday bonuses |
| `achievements-queue` | `process-achievement` | domain event | Updates achievement progress and rewards |

Redis Insight key patterns:

```text
bull:loyalty-queue:*
bull:achievements-queue:*
```

## Data Model

| Table | Purpose |
| --- | --- |
| `loyalty_profiles` | Current loyalty balance, tier, yearly stats, birthday date, GOLD usage |
| `points_transactions` | Audit log for all point changes |
| `processed_events` | Idempotency for events and commands |
| `user_bonus_grants` | One-time bonus grant tracking |
| `outbox_events` | Reliable outbound domain events |
| `achievements` | Achievement definitions and criteria |
| `user_achievements` | User progress and unlock state |

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

| Requirement | Version / Notes |
| --- | --- |
| Node.js | `22+` recommended |
| npm | project package manager |
| PostgreSQL | required for Prisma datasource |
| Redis | required for BullMQ |
| RabbitMQ | required for event consumers/publishers |
| Buf CLI | optional, for proto lint/build checks |

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

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
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

Production build:

```bash
npm run build
npm run start:prod
```

After startup, the service runs:

| Runtime Part | Source |
| --- | --- |
| HTTP server | `PORT` |
| gRPC microservice | `GRPC_URL` |
| RabbitMQ microservice | `RMQ_QUEUE` |
| BullMQ workers | `loyalty-queue`, `achievements-queue` |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Build NestJS project |
| `npm run start` | Start app once |
| `npm run start:dev` | Start app in watch mode |
| `npm run start:prod` | Start compiled app from `dist/src/main` |
| `npm run lint` | Run ESLint with auto-fix |
| `npm run test` | Run unit tests |
| `npm run test:cov` | Run tests with coverage |
| `npm run test:e2e` | Run e2e tests |
| `npm run buf:lint` | Lint proto files |
| `npm run buf:build` | Validate proto build |

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

| Problem | Fix |
| --- | --- |
| `Cannot find module './internal/class.js'` | Run `npx prisma generate` and rebuild |
| Proto file not found in `dist` | Check `cwd` and make sure `src/proto` or `dist/proto` exists |
| Completed BullMQ jobs disappear | Production jobs may remove completed entries |
| Redis key is not named `completed` | Open the concrete job hash, for example `bull:loyalty-queue:<job-id>` |

BullMQ state indexes are stored separately:

```text
bull:loyalty-queue:delayed
bull:loyalty-queue:completed
bull:loyalty-queue:failed
```

## Related Documentation

| File | Purpose |
| --- | --- |
| [`src/proto/loyalty/v1/loyalty.proto`](src/proto/loyalty/v1/loyalty.proto) | gRPC API contract |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Database model |

## License

Internal / UNLICENSED.
