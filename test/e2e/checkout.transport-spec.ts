import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { connect } from 'amqplib';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Run bun run test:transports (${name} missing)`);
  return value;
}

async function eventually(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}

describe('Monolith HTTP → loyalty gRPC/RabbitMQ → achievement delivery', () => {
  let monolith: Pool;
  let loyalty: Pool;
  let redis: Redis;
  let firstOrder: string;
  let secondOrder: string;
  const userId = randomUUID();
  const sessionId = randomUUID();
  const seats = [randomUUID(), randomUUID(), randomUUID()];
  const achievementId = randomUUID();
  let token: string;

  function compose(...args: string[]): void {
    const parsed: unknown = JSON.parse(required('E2E_COMPOSE_ARGS'));
    if (
      !Array.isArray(parsed) ||
      !parsed.every((arg): arg is string => typeof arg === 'string')
    )
      throw new Error('Invalid Compose arguments');
    const result = spawnSync('docker', [...parsed, ...args], {
      stdio: 'inherit',
    });
    if (result.status !== 0)
      throw new Error(`Compose ${args.join(' ')} failed`);
  }

  beforeAll(async () => {
    monolith = new Pool({
      connectionString: required('E2E_MONOLITH_DATABASE_URL'),
    });
    loyalty = new Pool({
      connectionString: required('E2E_LOYALTY_DATABASE_URL'),
    });
    redis = new Redis({
      host: '127.0.0.1',
      port: Number(required('E2E_MONOLITH_REDIS_PORT')),
      password: 'redis_password',
    });
    await eventually(
      async () => {
        try {
          const responses = await Promise.all([
            fetch(required('E2E_MONOLITH_URL') + '/swagger/v1/swagger.json', {
              signal: AbortSignal.timeout(2000),
            }),
            fetch(required('E2E_LOYALTY_URL'), {
              signal: AbortSignal.timeout(2000),
            }),
          ]);
          return responses[0].ok && responses[1].status === 404;
        } catch {
          return false;
        }
      },
      'both applications ready',
      60000,
    );

    const hallId = randomUUID();
    const movieId = randomUUID();
    const seatTypeId = randomUUID();
    const pricingId = randomUUID();
    await monolith.query(
      `INSERT INTO "AspNetUsers" (id, email, user_name, first_name, last_name, email_confirmed, phone_number_confirmed, two_factor_enabled, lockout_enabled, access_failed_count)
      VALUES ($1, 'checkout@example.test', 'checkout@example.test', 'Local', 'Test', true, false, false, false, 0)`,
      [userId],
    );
    await monolith.query(
      `INSERT INTO halls (id, name, total_capacity, is_active) VALUES ($1, 'Isolated E2E hall', 3, true)`,
      [hallId],
    );
    await monolith.query(
      `INSERT INTO movies (id, title, duration_minutes, release_year, rating, is_deleted, status) VALUES ($1, 'Isolated E2E movie', 120, 2026, 7, false, 0)`,
      [movieId],
    );
    await monolith.query(
      `INSERT INTO seat_types (id, name) VALUES ($1, 'Standard')`,
      [seatTypeId],
    );
    await monolith.query(
      `INSERT INTO pricings (id, name) VALUES ($1, 'E2E pricing')`,
      [pricingId],
    );
    await monolith.query(
      `INSERT INTO pricing_items (id, pricing_id, seat_type_id, price) VALUES ($1, $2, $3, 400)`,
      [randomUUID(), pricingId, seatTypeId],
    );
    await monolith.query(
      `INSERT INTO sessions (id, hall_id, movie_id, pricing_id, start_time, end_time, status, event_type, is_loyalty_payment_allowed)
      VALUES ($1, $2, $3, $4, NOW() + interval '2 days', NOW() + interval '2 days 2 hours', 1, 'STANDARD', true)`,
      [sessionId, hallId, movieId, pricingId],
    );
    for (const [index, seat] of seats.entries()) {
      await monolith.query(
        `INSERT INTO seats (id, hall_id, seat_type_id, row_label, number, grid_x, grid_y, status) VALUES ($1, $2, $3, 'A', $4, $4, 1, 1)`,
        [seat, hallId, seatTypeId, index + 1],
      );
    }
    await loyalty.query(
      `INSERT INTO loyalty_profiles (id, user_id, balance, updated_at) VALUES ($1, $2, 500, NOW())`,
      [randomUUID(), userId],
    );
    await loyalty.query(
      `INSERT INTO achievements (id, code, name, description, icon, category, strategy, criteria, reward_points, updated_at)
      VALUES ($1, 'TRANSPORT_TEST', 'Two purchases', 'E2E', 'test', 'VISITS', 'THRESHOLD', $2::jsonb, 30, NOW())`,
      [
        achievementId,
        JSON.stringify({
          field: 'TICKET_PURCHASED',
          operator: 'gte',
          target: 2,
        }),
      ],
    );
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: userId,
        iss: 'loyalty-e2e',
        aud: 'loyalty-e2e',
        exp: Math.floor(Date.now() / 1000) + 1800,
      }),
    ).toString('base64url');
    const signature = createHmac(
      'sha256',
      'local-integration-jwt-secret-at-least-32-bytes',
    )
      .update(`${header}.${payload}`)
      .digest('base64url');
    token = `${header}.${payload}.${signature}`;
  });

  afterAll(async () => {
    if (redis) await redis.quit();
    if (monolith) await monolith.end();
    if (loyalty) await loyalty.end();
  });

  async function checkout(
    seat: string,
    useLoyaltyPoints: boolean,
  ): Promise<string> {
    await redis.set(`lock:session:{${sessionId}}:${seat}`, userId, 'EX', 600);
    const response = await fetch(required('E2E_MONOLITH_URL') + '/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionId,
        seatIds: [seat],
        paymentToken: 'local-success-token',
        useLoyaltyPoints,
        applyGoldUpgrade: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body: unknown = await response.json();
    if (!response.ok || typeof body !== 'string')
      throw new Error(
        `Checkout HTTP ${response.status}: ${JSON.stringify(body)}`,
      );
    await eventually(
      async () =>
        (
          await loyalty.query(
            'SELECT event_id FROM processed_events WHERE event_id = $1',
            [body],
          )
        ).rowCount === 1,
      'TicketPurchased committed',
    );
    return body;
  }

  async function intents(orderId: string): Promise<number> {
    const result = await loyalty.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM achievement_dispatch_intents WHERE event_id = $1 AND action_type = 'TICKET_PURCHASED'`,
      [orderId],
    );
    return result.rows[0].count;
  }

  async function profile() {
    return (
      await loyalty.query<{
        balance: number;
        lifetime_points: number;
        year_points: number;
        year_visits: number;
        tier: string;
      }>(
        'SELECT balance, lifetime_points, year_points, year_visits, tier FROM loyalty_profiles WHERE user_id = $1',
        [userId],
      )
    ).rows[0];
  }

  it('HTTP checkout uses real gRPC deduction and saves achievement intent through RabbitMQ', async () => {
    firstOrder = await checkout(seats[0], true);
    expect(
      (
        await monolith.query<{ status: number }>(
          'SELECT status FROM orders WHERE id = $1',
          [firstOrder],
        )
      ).rows[0].status,
    ).toBe(1);
    expect(
      (
        await loyalty.query<{ points: number }>(
          'SELECT points FROM points_transactions WHERE order_id = $1 AND type = $2',
          [firstOrder, 'BURN_DISCOUNT'],
        )
      ).rows,
    ).toEqual([{ points: -200 }]);
    await eventually(
      async () =>
        (
          await loyalty.query<{ current: number }>(
            'SELECT current FROM user_achievements WHERE user_id = $1',
            [userId],
          )
        ).rows[0]?.current === 1,
      'first achievement job processed',
    );
    expect(await intents(firstOrder)).toBe(1);
    expect(await profile()).toEqual({
      balance: 300,
      lifetime_points: 0,
      year_points: 0,
      year_visits: 1,
      tier: 'BRONZE',
    });
  });

  it('saves purchase and achievement intent while loyalty Redis is unavailable', async () => {
    compose('stop', 'loyalty-redis');
    secondOrder = await checkout(seats[1], false);
    expect(
      (
        await loyalty.query<{ year_visits: number }>(
          'SELECT year_visits FROM loyalty_profiles WHERE user_id = $1',
          [userId],
        )
      ).rows[0].year_visits,
    ).toBe(2);
    expect(await intents(secondOrder)).toBe(1);
    await eventually(
      async () =>
        (
          await loyalty.query<{ attempts: number; delivered_at: Date | null }>(
            'SELECT attempts, delivered_at FROM achievement_dispatch_intents WHERE event_id = $1',
            [secondOrder],
          )
        ).rows.some((row) => row.attempts > 0 && row.delivered_at === null),
      'failed Redis delivery remains pending',
    );
    expect(await profile()).toEqual({
      balance: 700,
      lifetime_points: 400,
      year_points: 400,
      year_visits: 2,
      tier: 'BRONZE',
    });
  });

  it('recovers persisted work after Redis returns, including a loyalty process restart', async () => {
    // A restart distinguishes durable delivery from an in-memory pending Redis promise.
    compose('stop', 'loyalty-service');
    compose('start', 'loyalty-redis', 'loyalty-service');
    await eventually(
      async () =>
        (
          await loyalty.query<{ current: number }>(
            'SELECT current FROM user_achievements WHERE user_id = $1',
            [userId],
          )
        ).rows[0]?.current === 2,
      'second achievement job recovered',
    );
    expect(
      (
        await loyalty.query(
          'SELECT id FROM points_transactions WHERE user_id = $1 AND type = $2',
          [userId, 'EARN_ACHIEVEMENT'],
        )
      ).rowCount,
    ).toBe(1);
    expect(await profile()).toEqual({
      balance: 730,
      lifetime_points: 430,
      year_points: 400,
      year_visits: 2,
      tier: 'BRONZE',
    });
    await eventually(
      async () =>
        (
          await loyalty.query(
            'SELECT id FROM achievement_dispatch_intents WHERE user_id = $1 AND delivered_at IS NOT NULL',
            [userId],
          )
        ).rowCount === 2,
      'both intents delivered',
    );
  });

  it('compensates the actual checkout debit when the monolith payment is declined', async () => {
    const before = await profile();
    await redis.set(
      `lock:session:{${sessionId}}:${seats[2]}`,
      userId,
      'EX',
      600,
    );
    const response = await fetch(required('E2E_MONOLITH_URL') + '/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionId,
        seatIds: [seats[2]],
        paymentToken: 'test_fail_token',
        useLoyaltyPoints: true,
        applyGoldUpgrade: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    expect(response.ok).toBe(false);
    await response.text();
    const compensation = await loyalty.query<{
      order_id: string;
      debit: number;
      refund: number;
    }>(
      `SELECT d.order_id, d.points AS debit, r.points AS refund FROM checkout_debits c
       JOIN points_transactions d ON d.id=c.debit_id
       JOIN points_transactions r ON r.id=c.refund_id
       WHERE d.user_id=$1`,
      [userId],
    );
    expect(compensation.rows).toHaveLength(1);
    expect(compensation.rows[0]).toMatchObject({ debit: -200, refund: 200 });
    expect(await profile()).toEqual(before);
    expect(await intents(compensation.rows[0].order_id)).toBe(0);
  });

  it('does not duplicate progress or reward after TicketPurchased redelivery', async () => {
    expect(firstOrder).toBeDefined();
    const profileBefore = await profile();
    const ledgerBefore = (
      await loyalty.query(
        'SELECT id, points, balance_after FROM points_transactions WHERE user_id = $1 ORDER BY id',
        [userId],
      )
    ).rows;
    const before = (
      await loyalty.query(
        'SELECT current, is_unlocked FROM user_achievements WHERE user_id = $1',
        [userId],
      )
    ).rows;
    const connection = await connect(required('E2E_RABBIT_URL'));
    const channel = await connection.createConfirmChannel();
    const queueUrl =
      required('E2E_RABBIT_HTTP') + '/api/queues/%2F/loyalty_ticket_purchased';
    const queueState = async (): Promise<{ ack: number; messages: number }> => {
      const response = await fetch(queueUrl, {
        headers: {
          Authorization:
            'Basic ' + Buffer.from('guest:guest').toString('base64'),
        },
      });
      const state: unknown = await response.json();
      if (
        typeof state !== 'object' ||
        state === null ||
        !('message_stats' in state) ||
        !('messages' in state)
      )
        return { ack: 0, messages: -1 };
      const stats = state.message_stats;
      return {
        ack:
          typeof stats === 'object' &&
          stats !== null &&
          'ack' in stats &&
          typeof stats.ack === 'number'
            ? stats.ack
            : 0,
        messages: typeof state.messages === 'number' ? state.messages : -1,
      };
    };
    try {
      const original = await queueState();
      channel.sendToQueue(
        'loyalty_ticket_purchased',
        Buffer.from(
          JSON.stringify({
            pattern: 'TicketPurchased',
            data: {
              eventId: firstOrder,
              orderId: firstOrder,
              userId,
              totalAmount: 400,
              ticketAmount: 400,
              foodAmount: 0,
              paidAmount: 200,
              pointsUsed: 200,
              eventType: 'STANDARD',
              purchasedAt: new Date().toISOString(),
            },
          }),
        ),
        { persistent: true },
      );
      await channel.waitForConfirms();
      await eventually(async () => {
        const state = await queueState();
        return state.ack > original.ack && state.messages === 0;
      }, 'RabbitMQ redelivery acknowledged');
      expect(
        (
          await loyalty.query(
            'SELECT current, is_unlocked FROM user_achievements WHERE user_id = $1',
            [userId],
          )
        ).rows,
      ).toEqual(before);
      expect(await intents(firstOrder)).toBe(1);
      expect(await profile()).toEqual(profileBefore);
      expect(
        (
          await loyalty.query(
            'SELECT id, points, balance_after FROM points_transactions WHERE user_id = $1 ORDER BY id',
            [userId],
          )
        ).rows,
      ).toEqual(ledgerBefore);
      expect(
        (
          await loyalty.query(
            'SELECT id FROM points_transactions WHERE user_id = $1 AND type = $2',
            [userId, 'EARN_ACHIEVEMENT'],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await channel.close();
      await connection.close();
    }
  });
});
