import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  LOYALTY_QUEUE_NAME,
  LOYALTY_JOBS,
  CRON_SCHEDULES,
  EVERY_DAY_00_10_CRON,
  GRANT_BIRTHDAY_BONUSES_JOB,
} from '../constants/loyalty.constants';

@Injectable()
export class LoyaltySchedulerProducer implements OnModuleInit {
  constructor(
    @InjectQueue(LOYALTY_QUEUE_NAME) private readonly loyaltyQueue: Queue,
  ) {}

  async onModuleInit() {
    await this.loyaltyQueue.add(
      LOYALTY_JOBS.EXPIRE_POINTS,
      {},
      {
        repeat: { pattern: CRON_SCHEDULES.EVERY_NIGHT_03_00 },
        jobId: `${LOYALTY_JOBS.EXPIRE_POINTS}-schedule`,
      },
    );

    await this.loyaltyQueue.add(
      LOYALTY_JOBS.NOTIFY_EXPIRING,
      {},
      {
        repeat: { pattern: CRON_SCHEDULES.EVERY_NIGHT_04_00 },
        jobId: `${LOYALTY_JOBS.NOTIFY_EXPIRING}-schedule`,
      },
    );

    await this.loyaltyQueue.add(
      LOYALTY_JOBS.ANNUAL_RESET,
      {},
      {
        repeat: { pattern: CRON_SCHEDULES.FIRST_OF_JAN_00_05 },
        jobId: `${LOYALTY_JOBS.ANNUAL_RESET}-schedule`,
      },
    );

    await this.loyaltyQueue.add(
      LOYALTY_JOBS.GOLD_RESET,
      {},
      {
        repeat: { pattern: CRON_SCHEDULES.FIRST_OF_MONTH_01_00 },
        jobId: `${LOYALTY_JOBS.GOLD_RESET}-schedule`,
      },
    );

    await this.loyaltyQueue.add(
      GRANT_BIRTHDAY_BONUSES_JOB,
      {},
      {
        repeat: {
          pattern: EVERY_DAY_00_10_CRON,
          tz: 'UTC',
        },
        jobId: `${GRANT_BIRTHDAY_BONUSES_JOB}-schedule`,
      },
    );

    await this.loyaltyQueue.add(LOYALTY_JOBS.NOTIFY_EXPIRING, {});
  }
}
