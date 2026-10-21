import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import appConfig, {
  createRuntimeConfiguration,
  replayConfig,
} from './app.config';
import type { RuntimeConfiguration } from './app.config';
import { getBullConfig } from './bullmq.config';
import { getRabbitMqConfig } from './rabbitmq.config';
import { bootstrap } from '../main';
import { configureHttp } from './configure-http';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

const required = {
  DATABASE_URL:
    'postgresql://user:PRIVATE_PASSWORD@localhost:5432/loyalty?schema=public',
  INTERNAL_API_KEY: 'PRIVATE_API_KEY',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: '',
};

// Use the application's actual ConfigModule factory, without infrastructure.
@Module({
  imports: [
    ConfigModule.forRoot({
      ignoreEnvFile: true,
      skipProcessEnv: true,
      load: [appConfig],
    }),
  ],
})
class ConfigurationProbeModule {}

describe('Runtime environment validation', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('parses a complete configuration and preserves both distinct RabbitMQ queues', () => {
    const config = createRuntimeConfiguration({
      ...required,
      PORT: '4000',
      GRPC_URL: '[::]:50051',
      FRONTEND_URL: 'https://cinema.example:8443',
      RMQ_URL: 'amqps://guest:secret@broker:5671/%2F',
      RMQ_QUEUE: 'purchases',
      RMQ_LOYALTY_EVENTS_QUEUE: 'events',
      OUTBOX_PUBLISH_TIMEOUT_MS: '40000',
      OUTBOX_LEASE_MS: '50000',
      OUTBOX_PUBLISH_CONCURRENCY: '10',
      RMQ_MAX_ATTEMPTS: '4',
      RMQ_PREFETCH: '8',
      RMQ_RETRY_BASE_MS: '500',
      RMQ_RETRY_MAX_MS: '5000',
      RMQ_DELIVERY_LEASE_MS: '10000',
    });
    expect(config.app).toEqual({
      port: 4000,
      grpcUrl: '[::]:50051',
      rmqUrl: 'amqps://guest:secret@broker:5671/%2F',
      rmqQueue: 'purchases',
      outboxPublishTimeoutMs: 40000,
      outboxLeaseMs: 50000,
      outboxPublishConcurrency: 10,
    });
    expect(config.rmqDelivery).toEqual({
      maxAttempts: 4,
      prefetch: 8,
      retryBaseMs: 500,
      retryMaxMs: 5000,
      leaseMs: 10000,
    });
    const service = new ConfigService<RuntimeConfiguration>(config);
    expect(getBullConfig(service)).toEqual({
      connection: { host: 'localhost', port: 6379, password: '' },
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
    expect(getRabbitMqConfig(service)).toMatchObject({
      options: {
        urls: [config.app.rmqUrl],
        queue: 'events',
        queueOptions: { durable: true },
      },
    });
  });

  it('preserves all application defaults and strips unrelated variables', () => {
    const config = createRuntimeConfiguration({
      ...required,
      UNUSED_SECRET: 'PRIVATE_UNUSED',
    });
    expect(config.app).toEqual({
      port: 3000,
      grpcUrl: '0.0.0.0:50051',
      rmqUrl: 'amqp://localhost:5672',
      rmqQueue: 'loyalty_ticket_purchased',
      outboxPublishTimeoutMs: 10000,
      outboxLeaseMs: 30000,
      outboxPublishConcurrency: 5,
    });
    expect(config.FRONTEND_URL).toBe('http://localhost:3000');
    expect(config.RMQ_LOYALTY_EVENTS_QUEUE).toBe('loyalty.events');
    expect(config.rmqDelivery).toEqual({
      maxAttempts: 3,
      prefetch: 5,
      retryBaseMs: 1000,
      retryMaxMs: 30000,
      leaseMs: 30000,
    });
    expect(config).not.toHaveProperty('UNUSED_SECRET');
  });

  it.each([
    'DATABASE_URL',
    'INTERNAL_API_KEY',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
  ])('rejects missing required %s', (key) => {
    const input: Record<string, unknown> = { ...required };
    delete input[key];
    expect(() => createRuntimeConfiguration(input)).toThrow(key);
  });

  it.each(['PORT', 'REDIS_PORT'])(
    'rejects malformed or invalid TCP port %s',
    (key) => {
      for (const value of [
        '0',
        '-1',
        '65536',
        '1.5',
        '3000oops',
        '',
        ' ',
        'NaN',
        'Infinity',
        '1e3',
        '0x10',
        NaN,
        Infinity,
        true,
      ])
        expect(() =>
          createRuntimeConfiguration({ ...required, [key]: value }),
        ).toThrow(key);
      for (const value of ['1', '65535'])
        expect(
          createRuntimeConfiguration({ ...required, [key]: value })[key],
        ).toBe(Number(value));
    },
  );

  it.each([
    ['OUTBOX_PUBLISH_TIMEOUT_MS', '0'],
    ['OUTBOX_PUBLISH_TIMEOUT_MS', '2147483648'],
    ['OUTBOX_PUBLISH_TIMEOUT_MS', '1.5'],
    ['OUTBOX_LEASE_MS', '10000'],
    ['OUTBOX_LEASE_MS', '9999'],
    ['OUTBOX_LEASE_MS', '2147483648'],
    ['OUTBOX_PUBLISH_CONCURRENCY', '0'],
    ['OUTBOX_PUBLISH_CONCURRENCY', '51'],
    ['RMQ_MAX_ATTEMPTS', '11'],
    ['RMQ_PREFETCH', '0'],
    ['RMQ_RETRY_BASE_MS', '49'],
    ['RMQ_RETRY_MAX_MS', '999'],
    ['RMQ_DELIVERY_LEASE_MS', '9999'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() =>
      createRuntimeConfiguration({ ...required, [key]: value }),
    ).toThrow(key);
  });

  it('preserves derived lease defaults and exact timeout/lease bounds', () => {
    expect(
      createRuntimeConfiguration({
        ...required,
        OUTBOX_PUBLISH_TIMEOUT_MS: '40000',
      }).app.outboxLeaseMs,
    ).toBe(45000);
    expect(
      createRuntimeConfiguration({
        ...required,
        OUTBOX_PUBLISH_TIMEOUT_MS: '2147483646',
        OUTBOX_LEASE_MS: '2147483647',
      }).app.outboxLeaseMs,
    ).toBe(2147483647);
    expect(() =>
      createRuntimeConfiguration({
        ...required,
        OUTBOX_PUBLISH_TIMEOUT_MS: '2147483647',
      }),
    ).toThrow('OUTBOX_LEASE_MS');
    expect(() =>
      createRuntimeConfiguration({
        ...required,
        OUTBOX_PUBLISH_TIMEOUT_MS: '2147483647',
        OUTBOX_LEASE_MS: '2147483647',
      }),
    ).toThrow('OUTBOX_LEASE_MS');
    expect(
      createRuntimeConfiguration({
        ...required,
        OUTBOX_PUBLISH_TIMEOUT_MS: '1',
        OUTBOX_LEASE_MS: '2',
        OUTBOX_PUBLISH_CONCURRENCY: '50',
      }).app.outboxPublishConcurrency,
    ).toBe(50);
  });

  it.each([
    ['DATABASE_URL', 'https://user:PRIVATE_PASSWORD@host/db'],
    ['INTERNAL_API_KEY', ' '],
    ['REDIS_HOST', 'redis://host'],
    ['RMQ_URL', 'https://user:PRIVATE_PASSWORD@host'],
    ['RMQ_QUEUE', ''],
    ['RMQ_LOYALTY_EVENTS_QUEUE', ' '],
    ['GRPC_URL', 'http://localhost:50051'],
    ['GRPC_URL', 'localhost:0'],
    ['GRPC_URL', 'localhost:65536'],
    ['GRPC_URL', '[not-ipv6]:50051'],
    ['FRONTEND_URL', 'https://user:PRIVATE_PASSWORD@host'],
    ['FRONTEND_URL', 'https://host/path'],
    ['FRONTEND_URL', '*'],
  ])('rejects invalid %s without exposing input', (key, value) => {
    expect(() =>
      createRuntimeConfiguration({ ...required, [key]: value }),
    ).toThrow(key);
    try {
      createRuntimeConfiguration({ ...required, [key]: value });
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_PASSWORD');
      expect(String(error)).not.toContain('PRIVATE_API_KEY');
    }
  });

  it('canonicalizes CORS origins to the browser serialization used by HTTP responses', async () => {
    process.env = { ...required, FRONTEND_URL: 'https://Cinema.Example:443/' };
    const module = await Test.createTestingModule({
      imports: [ConfigurationProbeModule],
    }).compile();
    const app = module.createNestApplication<INestApplication<Server>>({
      logger: false,
    });
    try {
      const config =
        module.get<ConfigService<RuntimeConfiguration>>(ConfigService);
      const frontendUrl = config.getOrThrow('FRONTEND_URL', { infer: true });
      expect(frontendUrl).toBe('https://cinema.example');
      configureHttp(app, frontendUrl);
      await app.init();
      const response = await request(app.getHttpServer())
        .get('/')
        .set('Origin', frontendUrl)
        .expect(404);
      expect(response.headers['access-control-allow-origin']).toBe(frontendUrl);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  it('keeps replay independent of Redis, API key and full application settings', () => {
    process.env = {
      DATABASE_URL: required.DATABASE_URL,
      PORT: 'not-used-by-replay',
    };
    expect(replayConfig()).toEqual({
      DATABASE_URL: required.DATABASE_URL,
      RMQ_URL: 'amqp://localhost:5672',
      RMQ_QUEUE: 'loyalty_ticket_purchased',
      app: {
        rmqUrl: 'amqp://localhost:5672',
        rmqQueue: 'loyalty_ticket_purchased',
      },
    });
  });

  it('exposes parsed numbers through the actual Nest ConfigModule, ignoring later raw env changes', async () => {
    process.env = { ...required };
    const module = await Test.createTestingModule({
      imports: [ConfigurationProbeModule],
    }).compile();
    try {
      process.env.REDIS_PORT = 'broken-after-validation';
      const config =
        module.get<ConfigService<RuntimeConfiguration>>(ConfigService);
      expect(config.getOrThrow('REDIS_PORT', { infer: true })).toBe(6379);
      expect(getBullConfig(config).connection).toMatchObject({ port: 6379 });
      expect(getRabbitMqConfig(config)).toMatchObject({
        options: { queue: 'loyalty.events' },
      });
    } finally {
      await module.close();
    }
  });

  it('rejects invalid config during dependency creation before transports or lifecycle hooks open', async () => {
    process.env = { ...required, REDIS_PORT: 'invalid' };
    let connected = false;
    jest.spyOn(NestFactory, 'create').mockImplementation(async () => {
      const module = await Test.createTestingModule({
        imports: [ConfigurationProbeModule],
      }).compile();
      const app = module.createNestApplication({ logger: false });
      // Reaching this line would allow bootstrap to attach transports.
      connected = true;
      return app;
    });
    await expect(bootstrap()).rejects.toThrow('REDIS_PORT');
    expect(connected).toBe(false);
  });
});
