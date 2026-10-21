import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BullRegistrar, getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from 'eventemitter2';
import { of, throwError } from 'rxjs';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { PrismaModule } from './prisma/prisma.module';
import {
  INJECTION_TOKENS,
  LOYALTY_JOBS_QUEUE_NAME,
  RABBITMQ_EVENTS,
} from './loyalty/constants/loyalty.constants';
import { ACHIEVEMENTS_QUEUE } from './achievements/constants/achievements.constants';

class PrismaConnectionProbe {
  static connected = new Set<PrismaConnectionProbe>();
  onModuleInit() {
    PrismaConnectionProbe.connected.add(this);
  }
}

describe('Application provider ownership', () => {
  let module: TestingModule;
  const emit = jest.fn<(...args: unknown[]) => ReturnType<typeof of>>();
  const originalEnv = process.env;
  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgresql://fixture.invalid/unused',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_PASSWORD: 'unused',
      INTERNAL_API_KEY: 'fixture',
    };
    PrismaConnectionProbe.connected.clear();
    emit.mockReset().mockReturnValue(of(undefined));
    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          DATABASE_URL: 'postgresql://fixture.invalid/unused',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: 6379,
          REDIS_PASSWORD: 'unused',
          INTERNAL_API_KEY: 'fixture',
          rmqDelivery: {
            maxAttempts: 3,
            prefetch: 5,
            retryBaseMs: 1000,
            retryMaxMs: 30000,
            leaseMs: 30000,
          },
          app: {
            rmqQueue: 'fixture',
            outboxPublishTimeoutMs: 100,
            outboxLeaseMs: 1000,
            outboxPublishConcurrency: 1,
          },
        }),
      )
      .overrideProvider(PrismaService)
      .useClass(PrismaConnectionProbe)
      .overrideProvider(BullRegistrar)
      .useValue({ onModuleInit() {} })
      .overrideProvider(getQueueToken(LOYALTY_JOBS_QUEUE_NAME))
      .useValue({ add: () => Promise.resolve() })
      .overrideProvider(getQueueToken(ACHIEVEMENTS_QUEUE))
      .useValue({ add: () => Promise.resolve() })
      .overrideProvider(INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT)
      .useValue({ emit })
      .compile();
    await module.init();
  });
  afterEach(async () => {
    process.env = originalEnv;
    await module?.close();
  });

  it('initializes one Prisma provider and resolves it through the owning global module', () => {
    expect(PrismaConnectionProbe.connected.size).toBe(1);
    expect(module.get(PrismaService)).toBe(
      module.select(PrismaModule).get(PrismaService, { strict: true }),
    );
  });

  it('initializes one event bus and registers the tier subscriber exactly once', async () => {
    const emitters = module.get(EventEmitter2, { each: true });
    expect(emitters).toHaveLength(1);
    const emitter = module.get(EventEmitter2);
    expect(emitter.listenerCount(RABBITMQ_EVENTS.TIER_UPGRADED)).toBe(1);
    await emitter.emitAsync(
      RABBITMQ_EVENTS.TIER_UPGRADED,
      { userId: 'fixture-user', oldTier: 'BRONZE', newTier: 'SILVER' },
      {
        eventId: 'fixture-event',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
      },
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('propagates tier publication failure through the real registered listener', async () => {
    emit.mockReturnValue(throwError(() => new Error('fixture-broker-failure')));
    await expect(
      module
        .get(EventEmitter2)
        .emitAsync(
          RABBITMQ_EVENTS.TIER_UPGRADED,
          { userId: 'fixture-user', oldTier: 'BRONZE', newTier: 'SILVER' },
          { eventId: 'fixture-event', occurredAt: new Date() },
        ),
    ).rejects.toThrow('fixture-broker-failure');
  });
});
