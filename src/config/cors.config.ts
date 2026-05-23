import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const getCorsConfig = (frontendUrl: string): CorsOptions => ({
  origin: frontendUrl || 'http://localhost:3000',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  credentials: true,
  allowedHeaders: 'Content-Type, Accept, Authorization',
});
