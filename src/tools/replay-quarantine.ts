import 'reflect-metadata';
import { Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { connect } from 'amqplib';
import appConfig from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { QuarantineReplayService } from '../loyalty/consumers/quarantine-replay.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, load: [appConfig] })],
  providers: [PrismaService, QuarantineReplayService],
})
class ReplayModule {}

async function main() {
  const args = process.argv.slice(2);
  const id = args[args.indexOf('--delivery-id') + 1];
  const replayId = args[args.indexOf('--replay-id') + 1];
  if (
    !args.includes('--consumers-stopped') ||
    !args.includes('--delivery-id') ||
    !args.includes('--replay-id') ||
    !id ||
    !replayId
  )
    throw new Error(
      'REPLAY_REQUIRES_DELIVERY_ID_REPLAY_ID_AND_STOPPED_CONSUMERS',
    );
  const app = await NestFactory.createApplicationContext(ReplayModule, {
    logger: false,
  });
  const prisma = app.get(PrismaService);
  try {
    const config = app.get(ConfigService);
    const connection = await connect(config.getOrThrow<string>('app.rmqUrl'), {
      timeout: 5000,
    });
    connection.on('error', () => {});
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      try {
        await app.get(QuarantineReplayService).replay(id, replayId, channel);
        new Logger('QuarantineReplay').log(
          JSON.stringify({
            operation: 'replay',
            deliveryId: id,
            code: 'REPLAY_CONFIRMED',
          }),
        );
      } finally {
        await channel.close();
      }
    } finally {
      await connection.close();
    }
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
}

void main().catch(() => {
  // Connection/Prisma errors can contain credentials, raw data or private paths.
  new Logger('QuarantineReplay').error(
    'REPLAY_FAILED_OR_AMBIGUOUS: keep consumers stopped; inspect state and retry with the same replay ID',
  );
  process.exitCode = 1;
});
