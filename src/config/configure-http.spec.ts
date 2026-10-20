import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureHttp } from './configure-http';

@Controller('test-cors')
class CorsTestController {
  @Get() read() {
    return { ok: true };
  }
}

describe('HTTP CORS configuration', () => {
  let app: INestApplication<Server>;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CorsTestController],
    }).compile();
    app = module.createNestApplication();
    configureHttp(app, 'https://cinema.example.invalid');
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('uses the configured origin for ordinary responses', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-cors')
      .set('Origin', 'https://cinema.example.invalid')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://cinema.example.invalid',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
  it('does not reflect an arbitrary origin or replace configuration with wildcard', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-cors')
      .set('Origin', 'https://other.example.invalid')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://cinema.example.invalid',
    );
  });
  it('keeps preflight origin and credentials consistent', async () => {
    const response = await request(app.getHttpServer())
      .options('/test-cors')
      .set('Origin', 'https://cinema.example.invalid')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://cinema.example.invalid',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});
