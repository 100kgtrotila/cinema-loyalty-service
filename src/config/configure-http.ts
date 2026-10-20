import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getCorsConfig } from './cors.config';

export function configureHttp(
  app: INestApplication,
  frontendUrl: string,
): void {
  app.enableCors(getCorsConfig(frontendUrl));
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
