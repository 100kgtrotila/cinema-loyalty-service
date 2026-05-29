import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  LOYALTY_JOBS,
  LOYALTY_QUEUE_NAME,
} from '../constants/loyalty.constants';
import { LoyaltyExpirationService } from '../loyalty-expiration.service';
import { LoyaltyService } from '../loyalty.service';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

@Processor(LOYALTY_QUEUE_NAME)
export class LoyaltyQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(LoyaltyQueueProcessor.name);

  constructor(
    private readonly expirationService: LoyaltyExpirationService,
    private readonly loyaltyService: LoyaltyService,
  ) {
    super();
  }

  async process(job: Job<unknown, void, string>): Promise<void> {
    this.logger.log(`Початок обробки задачі: ${job.name} (ID: ${job.id})`);

    switch (job.name) {
      case LOYALTY_JOBS.EXPIRE_POINTS:
        await this.expirationService.expirePoints(async (total) => {
          await job.updateProgress(total);
        });
        break;

      case LOYALTY_JOBS.NOTIFY_EXPIRING:
        await this.expirationService.notifyExpiringUsers(async (total) => {
          await job.updateProgress(total);
        });
        break;

      case LOYALTY_JOBS.ANNUAL_RESET:
        await this.expirationService.annualReset(async (total) => {
          await job.updateProgress(total);
        });
        break;

      case LOYALTY_JOBS.GOLD_RESET:
        await this.expirationService.goldReset(async (total) => {
          await job.updateProgress(total);
        });
        break;

      case LOYALTY_JOBS.GRANT_BIRTHDAY_BONUSES:
        await this.loyaltyService.grantBirthdayBonuses(async (total) => {
          await job.updateProgress(total);
        });
        break;

      default:
        this.logger.error(`Отримано невідому задачу: ${job.name}`);
    }
  }
}
