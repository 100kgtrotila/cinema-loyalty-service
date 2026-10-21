import type { RuntimeConfiguration } from './app.config';
import { ConfigService } from '@nestjs/config';
import { BullRootModuleOptions } from '@nestjs/bullmq';

export function getBullConfig(
  configService: ConfigService<RuntimeConfiguration>,
): BullRootModuleOptions {
  return {
    connection: {
      host: configService.getOrThrow('REDIS_HOST', { infer: true }),
      port: configService.getOrThrow('REDIS_PORT', { infer: true }),
      password: configService.getOrThrow('REDIS_PASSWORD', { infer: true }),
    },
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  };
}
