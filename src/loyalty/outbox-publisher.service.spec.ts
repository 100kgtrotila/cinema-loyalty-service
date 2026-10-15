import { Test, TestingModule } from '@nestjs/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from 'eventemitter2';
import { NEVER, of, throwError } from 'rxjs';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  INJECTION_TOKENS,
  RABBITMQ_EVENTS,
} from './constants/loyalty.constants';
import { OutboxPublisherService } from './outbox-publisher.service';
import { TierUpgradeListener } from './notifications/tier-upgrade.listener';
import { RawOutboxEvent } from './interfaces/raw-outbox-event.interface';

describe('OutboxPublisherService', () => {
  let module: TestingModule;
  let publisher: OutboxPublisherService;
  const executeRaw = jest.fn<() => Promise<number>>();
  const queryRaw = jest.fn();
  const emit = jest.fn();
  const event: RawOutboxEvent = {
    id: 'event-1',
    type: RABBITMQ_EVENTS.TIER_UPGRADED,
    payload: { userId: 'user-1', oldTier: 'BRONZE', newTier: 'SILVER' },
    status: 'PROCESSING',
    aggregate_type: 'LOYALTY_PROFILE',
    aggregate_id: 'user-1',
    attempts: 1,
    max_attempts: 5,
    lease_token: 'claim-1',
    lease_expires_at: new Date(Date.now() + 1000),
    next_attempt_at: new Date(),
    error: null,
    published_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    executeRaw.mockResolvedValue(1);
    queryRaw.mockResolvedValueOnce([{ ...event }]).mockResolvedValue([]);
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        OutboxPublisherService,
        TierUpgradeListener,
        {
          provide: PrismaService,
          useValue: { $queryRaw: queryRaw, $executeRaw: executeRaw },
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            app: {
              outboxPublishTimeoutMs: 20,
              outboxLeaseMs: 1000,
              outboxPublishConcurrency: 2,
            },
          }),
        },
        {
          provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT,
          useValue: { emit },
        },
      ],
    }).compile();
    await module.init();
    publisher = module.get(OutboxPublisherService);
    expect(module.get(EventEmitter2).listenerCount(event.type)).toBeGreaterThan(
      0,
    );
  });

  afterEach(async () => {
    await module.close();
  });

  it('marks a successfully published event completed', async () => {
    emit.mockReturnValue(of(undefined));

    await publisher.publishPendingEvents();

    expect(emit).toHaveBeenCalledWith(
      event.type,
      expect.objectContaining({
        data: {
          userId: 'user-1',
          oldTier: 'BRONZE',
          newTier: 'SILVER',
          upgradedAt: event.created_at.toISOString(),
        },
        options: { messageId: event.id, persistent: true },
      }),
    );
    expect(executeRaw).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.stringContaining("status = 'COMPLETED'")]),
      event.id,
      event.lease_token,
    );
  });

  it('returns a broker failure to pending through the registered Nest listener', async () => {
    emit.mockReturnValue(throwError(() => new Error('broker unavailable')));

    await publisher.publishPendingEvents();

    expect(executeRaw).toHaveBeenCalledTimes(3); // Two recovery branches, then failure.
    expect(executeRaw).toHaveBeenLastCalledWith(
      expect.any(Array),
      5000,
      'broker unavailable',
      event.id,
      event.lease_token,
    );
  });

  it('marks exhausted attempts failed', async () => {
    queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ ...event, attempts: 5 }])
      .mockResolvedValue([]);
    emit.mockReturnValue(throwError(() => new Error('broker unavailable')));

    await publisher.publishPendingEvents();

    expect(executeRaw).toHaveBeenLastCalledWith(
      expect.any(Array),
      60000,
      'broker unavailable',
      event.id,
      event.lease_token,
    );
  });

  it('treats publication timeout as a retryable failure', async () => {
    emit.mockReturnValue(NEVER);

    await publisher.publishPendingEvents();

    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(executeRaw).toHaveBeenLastCalledWith(
      expect.any(Array),
      5000,
      expect.stringContaining('timed out'),
      event.id,
      event.lease_token,
    );
  });
});
