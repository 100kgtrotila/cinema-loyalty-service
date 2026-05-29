# 🌟 Cinema Loyalty Service

Microservice responsible for managing the **Loyalty Program** and **Achievements** for the Cinema Platform. Built with high-performance technologies to handle gRPC communication, background job processing, and reliable event-driven architecture.

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat&logo=nodedotjs)
![NestJS](https://img.shields.io/badge/NestJS-11.x-E0234E?style=flat&logo=nestjs)
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?style=flat&logo=prisma)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=flat&logo=postgresql)
![gRPC](https://img.shields.io/badge/gRPC-API-244C5A?style=flat&logo=google)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-Events-FF6600?style=flat&logo=rabbitmq)
![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?style=flat&logo=redis)

---

## 🏗️ Tech Stack & Patterns

- **Framework**: [NestJS](https://nestjs.com/) v11
- **Database**: PostgreSQL with **Prisma ORM** (`@prisma/adapter-pg`)
- **API Protocol**: **gRPC** (Protocol Buffers via `buf`)
- **Event Bus**: **RabbitMQ** (for listening to `TicketPurchased` events and publishing domain events)
- **Background Jobs**: **BullMQ** & **Redis** (for outbox processing and scheduled tasks)
- **Patterns**:
  - **Transactional Outbox Pattern**: Ensures reliable message delivery to RabbitMQ by storing events in the database (`outbox_events` table) within the same transaction as business logic.
  - **Cron Jobs**: Scheduled tasks for daily expiry of points and tier recalculations.

---

## ✨ Features

### 🏆 Loyalty Program

- **Tiers**: `BRONZE`, `SILVER`, `GOLD`.
- **Points Economy**: Users earn points from purchases and can spend them for ticket discounts.
- **Gold Seat Upgrades**: VIP feature allowing Gold-tier members to upgrade standard seats to VIP.
- **Expiration**: Points and Tiers expire based on specific business rules (processed via cron jobs).
- **Birthday Bonus**: DOB updates are stored on the loyalty profile. If the DOB event arrives on the user's birthday, the service grants a birthday bonus immediately. A daily UTC job also grants birthday bonuses for users whose birthday is today. The DB enforces one birthday bonus per user per UTC calendar year.

### Date-only Time Rule

All date-only loyalty comparisons, including birthday checks, use UTC LocalDate semantics. The service compares only UTC year/month/day fields, so birthday grants do not depend on the host machine timezone.

### 🥇 Achievements System

- Track user milestones (Visits, Spending, Time, Streak, Secret achievements).
- Criteria-based unlocks with varying rarities (Common, Epic, Legendary).
- Seamlessly rewards users with bonus loyalty points upon unlocking.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [Bun](https://bun.sh/) (Package manager & script runner)
- [Docker & Docker Compose](https://www.docker.com/) (For PostgreSQL, Redis, RabbitMQ)
- [Buf CLI](https://buf.build/docs/installation) (For compiling `.proto` files)

### 1. Environment Setup

Create a `.env` file in the root directory (or use the provided defaults in `.env.example` if available):

```env
NODE_ENV=development

# HTTP Server
PORT=3000

# gRPC Service
GRPC_URL=0.0.0.0:50051
INTERNAL_API_KEY=cinema-super-secret-internal-grpc-key-2026

# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/cinema_loyalty_db?schema=public"

# RabbitMQ
RMQ_URL=amqp://guest:guest@localhost:5672
RMQ_QUEUE=loyalty_ticket_purchased

# Redis (BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=redis_password

# JWT Validation
JWT_SECRET=your-super-secret-jwt-key
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Compile gRPC Proto Files

This project uses `buf` to manage and lint Protocol Buffers.

```bash
bun run buf:build
```

> The proto files are located in `src/proto/loyalty/v1/loyalty.proto`.

### 4. Database Initialization

Generate the Prisma Client and push the schema to your development database:

```bash
npx prisma generate
npx prisma db push
```

### 5. Running the Application

```bash
# development
bun run start

# watch mode (hot reload)
bun run start:dev

# production mode
bun run start:prod
```

---

## 📂 Project Structure

```text
src/
├── achievements/      # Achievement definitions, logic, and gRPC handlers
├── loyalty/           # Loyalty profiles, point transactions, tier calculations
├── common/            # Shared utilities, exceptions, and DTOs
├── config/            # Centralized environment variable validation
├── guards/            # Auth and API key guards for gRPC
├── prisma/            # Prisma service and Outbox repository
├── proto/             # Protocol Buffers (.proto files & buf configs)
└── generated/         # Auto-generated Prisma client
```

---

## 📡 API Integration (gRPC)

The Loyalty service exposes its functionality via **gRPC**. The main backend (`cinema-platform-back`) acts as a gRPC client.

### Exposed Services (see `loyalty.proto`)

- **LoyaltyService**:
  - `CalculateDiscount`, `UseGoldUpgrade`, `DeductPoints`, `RefundPoints`
  - `GetProfile`, `GetTransactions`, `ModifyPoints`, `GrantVipStatus`
- **AchievementsService**:
  - `GetAchievements`, `GetUserAchievements`
  - `CreateAchievement`, `UpdateAchievement`, `DeleteAchievement`

Authentication for admin/internal endpoints is handled via JWT metadata or an internal API key (`INTERNAL_API_KEY`).

---

## 🛠 Testing

```bash
# unit tests
bun run test

# test coverage
bun run test:cov
```

## 📜 License

This project is unlicensed or internal.
