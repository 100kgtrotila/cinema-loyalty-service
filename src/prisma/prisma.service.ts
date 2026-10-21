import type { RuntimeConfiguration } from '../config/app.config';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly configService: ConfigService<
      Pick<RuntimeConfiguration, 'DATABASE_URL'>
    >,
  ) {
    const adapter = new PrismaPg({
      connectionString: configService.getOrThrow('DATABASE_URL', {
        infer: true,
      }),
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
