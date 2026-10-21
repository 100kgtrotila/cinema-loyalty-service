import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PrismaService } from 'src/prisma/prisma.service';

describe('Prisma application lifecycle on PostgreSQL', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let observer: Pool;
  const applicationName = `loyalty-lifecycle-${randomUUID()}`;
  beforeAll(() => {
    const url = new URL(process.env.INTEGRATION_DATABASE_URL ?? '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/loyalty_integration')
      throw new Error('Use disposable integration runner');
    observer = new Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    try {
      await module?.close();
    } finally {
      try {
        await prisma?.$disconnect();
      } finally {
        await observer?.end();
      }
    }
  });
  it('disconnects the real global provider pool when the application closes', async () => {
    const url = new URL(process.env.INTEGRATION_DATABASE_URL ?? '');
    url.searchParams.set('application_name', applicationName);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ DATABASE_URL: url.toString() }))
      .compile();
    await module.init();
    prisma = module.get(PrismaService);
    await prisma.$queryRaw`SELECT 1`;
    const before = await observer.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1',
      [applicationName],
    );
    expect(before.rows[0].count).toBeGreaterThan(0);
    await module.close();
    const after = await observer.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1',
      [applicationName],
    );
    expect(after.rows[0].count).toBe(0);
  });
});
