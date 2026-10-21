import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleInit,
  OnModuleDestroy,
  INestApplication,
  INestMicroservice,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  CustomTransportStrategy,
  MicroserviceOptions,
  Server,
} from '@nestjs/microservices';
import { EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from 'eventemitter2';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { bootstrap, resolveProtoPath } from './main';

@Injectable()
class LifecycleDependency
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  initialized = false;
  bootstrapped = false;
  destroyed = false;
  failInit = false;
  async onModuleInit() {
    await Promise.resolve();
    if (this.failInit) throw new Error('fixture-initialization-failure');
    this.initialized = true;
  }
  onApplicationBootstrap() {
    this.bootstrapped = true;
  }
  onModuleDestroy() {
    this.destroyed = true;
  }
}
@Injectable()
class StartupListener {
  deliveries = 0;
  @OnEvent('startup-probe', { suppressErrors: false })
  handle() {
    this.deliveries++;
  }
}
@Controller('bootstrap-probe')
class ProbeController {
  @Get() read() {
    return { ok: true };
  }
}
@Module({
  imports: [EventEmitterModule.forRoot()],
  controllers: [ProbeController],
  providers: [LifecycleDependency, StartupListener],
})
class ProbeModule {}

class StartupTransport extends Server implements CustomTransportStrategy {
  opened = false;
  closed = false;
  observedInitialized = false;
  observedBootstrapped = false;
  constructor(
    private readonly dependency: LifecycleDependency,
    private readonly emitter: EventEmitter2,
    private readonly fail: boolean,
  ) {
    super();
  }
  listen(callback: (error?: Error) => void) {
    this.opened = true;
    this.observedInitialized = this.dependency.initialized;
    this.observedBootstrapped = this.dependency.bootstrapped;
    this.emitter.emit('startup-probe');
    callback(
      this.fail
        ? new Error('amqp://user:PRIVATE_CONNECTION_SECRET@fixture.invalid')
        : undefined,
    );
  }
  close() {
    this.closed = true;
  }
}

describe('Application bootstrap boundary', () => {
  let app: INestApplication<HttpServer> | undefined;
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    app = undefined;
  });

  async function fixture(failTransport = false) {
    const module = await Test.createTestingModule({
      imports: [ProbeModule],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            app: {
              port: 0,
              grpcUrl: '127.0.0.1:0',
              rmqUrl: 'amqp://fixture.invalid',
              rmqQueue: 'fixture',
            },
            FRONTEND_URL: 'https://cinema.example.invalid',
            rmqDelivery: { prefetch: 5 },
          }),
        },
      ],
    }).compile();
    const application = module.createNestApplication<
      INestApplication<HttpServer>
    >({ logger: false });
    app = application;
    jest.spyOn(NestFactory, 'create').mockResolvedValue(application);
    const transports: StartupTransport[] = [];
    const connect = application.connectMicroservice.bind(application) as (
      options: MicroserviceOptions,
    ) => INestMicroservice;
    jest.spyOn(application, 'connectMicroservice').mockImplementation(() => {
      const transport = new StartupTransport(
        module.get(LifecycleDependency),
        module.get(EventEmitter2),
        failTransport && transports.length === 1,
      );
      transports.push(transport);
      return connect({ strategy: transport });
    });
    return {
      application,
      transports,
      dependency: module.get(LifecycleDependency),
      listener: module.get(StartupListener),
    };
  }

  it('finishes dependency hooks and event subscription before accepting transport deliveries', async () => {
    const context = await fixture();
    await bootstrap();
    expect(context.transports).toHaveLength(2);
    for (const transport of context.transports) {
      expect(transport.observedInitialized).toBe(true);
      expect(transport.observedBootstrapped).toBe(true);
    }
    expect(context.listener.deliveries).toBe(2);
    await context.application.close();
    expect(context.dependency.destroyed).toBe(true);
    expect(context.transports.every((transport) => transport.closed)).toBe(
      true,
    );
  });

  it.each(['https://cinema.example.invalid', 'https://other.example.invalid'])(
    'preserves configured CORS for HTTP origin %s',
    async (origin) => {
      const { application } = await fixture();
      await bootstrap();
      const response = await request(application.getHttpServer())
        .get('/bootstrap-probe')
        .set('Origin', origin)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        'https://cinema.example.invalid',
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers.vary).toContain('Origin');
    },
  );

  it('preserves configured CORS methods and headers for preflight', async () => {
    const { application } = await fixture();
    await bootstrap();
    const response = await request(application.getHttpServer())
      .options('/bootstrap-probe')
      .set('Origin', 'https://cinema.example.invalid')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://cinema.example.invalid',
    );
    expect(response.headers['access-control-allow-methods']).toBe(
      'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    );
    expect(response.headers['access-control-allow-headers']).toBe(
      'Content-Type, Accept, Authorization',
    );
  });

  it('closes the application without starting transports when initialization fails', async () => {
    const context = await fixture();
    context.dependency.failInit = true;
    await expect(bootstrap()).rejects.toThrow('fixture-initialization-failure');
    expect(context.transports.some((transport) => transport.opened)).toBe(
      false,
    );
    expect(context.dependency.destroyed).toBe(true);
  });

  it('closes started transports when the HTTP port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, resolve);
    });
    try {
      const address = blocker.address();
      if (!address || typeof address === 'string')
        throw new Error('No fixture port');
      const context = await fixture();
      context.application.get(ConfigService).set('app.port', address.port);
      await expect(bootstrap()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(context.transports.every((transport) => transport.closed)).toBe(
        true,
      );
      expect(context.dependency.destroyed).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('reports dependency creation failure without logging its credentials', async () => {
    const secretError = new Error(
      'postgresql://fixture:PRIVATE_CONNECTION_SECRET@fixture.invalid/unused',
    );
    jest.spyOn(NestFactory, 'create').mockRejectedValueOnce(secretError);
    const errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    await expect(bootstrap()).rejects.toBe(secretError);
    expect(JSON.stringify(errors.mock.calls)).toContain('dependency creation');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(
      'PRIVATE_CONNECTION_SECRET',
    );
  });

  it('closes partially started transports and logs a safe failure without connection secrets', async () => {
    const context = await fixture(true);
    const errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    await expect(bootstrap()).rejects.toThrow('PRIVATE_CONNECTION_SECRET');
    expect(context.transports.every((transport) => transport.closed)).toBe(
      true,
    );
    expect(context.dependency.destroyed).toBe(true);
    expect(errors.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(
      'PRIVATE_CONNECTION_SECRET',
    );
  });
});

describe('Loyalty protobuf asset', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('resolves the source asset independent of the launch directory', () => {
    jest.spyOn(process, 'cwd').mockReturnValue('unrelated-launch-directory');
    expect(fs.readFileSync(resolveProtoPath(), 'utf8')).toContain(
      'package loyalty.v1;',
    );
  });
  it('fails clearly when the asset is absent instead of returning a nonexistent fallback', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(() => resolveProtoPath()).toThrow(/protobuf asset.*missing/i);
  });
});
