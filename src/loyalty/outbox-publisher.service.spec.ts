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
  const update = jest.fn();
  const queryRaw = jest.fn();
  const emit = jest.fn();
  const event: RawOutboxEvent = {
    id: 'event-1',
    type: RABBITMQ_EVENTS.TIER_UPGRADED,
    payload: { userId: 'user-1', oldTier: 'BRONZE', newTier: 'SILVER' },
    status: 'PENDING',
    aggregate_type: 'LOYALTY_PROFILE',
    aggregate_id: 'user-1',
    attempts: 0,
    max_attempts: 5,
    error: null,
    published_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        OutboxPublisherService,
        TierUpgradeListener,
        {
          provide: PrismaService,
          useValue: { $queryRaw: queryRaw, outboxEvent: { update } },
        },
        { provide: ConfigService, useValue: { getOrThrow: () => 20 } },
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
    queryRaw.mockResolvedValue([{ ...event }]);
    emit.mockReturnValue(of(undefined));

    await publisher.publishPendingEvents();

    expect(emit).toHaveBeenCalledWith(
      event.type,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: event.id },
      data: expect.objectContaining({
        status: 'COMPLETED',
        attempts: { increment: 1 },
      }),
    });
  });

  it('returns a broker failure to pending through the registered Nest listener', async () => {
    queryRaw.mockResolvedValue([{ ...event }]);
    emit.mockReturnValue(throwError(() => new Error('broker unavailable')));

    await publisher.publishPendingEvents();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: event.id },
      data: expect.objectContaining({
        status: 'PENDING',
        attempts: { increment: 1 },
      }),
    });
  });

  it('marks exhausted attempts failed', async () => {
    queryRaw.mockResolvedValue([{ ...event, attempts: 4 }]);
    emit.mockReturnValue(throwError(() => new Error('broker unavailable')));

    await publisher.publishPendingEvents();

    expect(update).toHaveBeenCalledWith({
      where: { id: event.id },
      data: expect.objectContaining({
        status: 'FAILED',
        attempts: { increment: 1 },
      }),
    });
  });

  it('treats publication timeout as a retryable failure', async () => {
    queryRaw.mockResolvedValue([{ ...event }]);
    emit.mockReturnValue(NEVER);

    await publisher.publishPendingEvents();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: event.id },
      data: expect.objectContaining({
        status: 'PENDING',
        error: expect.stringContaining('timed out'),
      }),
    });
  });
});
