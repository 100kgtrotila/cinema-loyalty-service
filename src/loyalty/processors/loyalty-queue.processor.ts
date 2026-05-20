import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  LOYALTY_JOBS,
  LOYALTY_QUEUE_NAME,
} from '../constants/loyalty.constants';
import { LoyaltyExpirationService } from '../loyalty-expiration.service';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

@Processor(LOYALTY_QUEUE_NAME)
export class LoyaltyQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(LoyaltyQueueProcessor.name);
  constructor(private readonly expirationService: LoyaltyExpirationService) {
    super();
  }

  async process(job: Job<undefined, void, string>): Promise<void> {
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
    }
  }
}
