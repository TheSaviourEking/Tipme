import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger, type DestinationStream } from '@tipme/observability';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './http/api-exception.filter.js';
import { requestContext } from './http/request-context.middleware.js';
import { SERVICE_NAME, type ApiConfig } from './config.js';

const CROSS_ORIGIN_PATHS = [
  '/v1/tip-quotes',
  '/v1/tip-intents',
  '/v1/tips/',
  '/v1/mock-provider/',
  '/v1/events',
];
// Recipient routes carry the session cookie, so the browser must send credentials.
const CREDENTIALED_PATHS = [
  '/v1/auth/',
  '/v1/me/',
  '/v1/dev/',
  '/v1/handles/',
  '/v1/ops/',
];

export interface CreateAppOptions {
  logDestination?: DestinationStream;
}

export async function createApp(
  config: ApiConfig,
  options: CreateAppOptions = {},
): Promise<INestApplication> {
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.LOG_LEVEL,
    destination: options.logDestination,
  });
  // Nest's own text logger is off: all output is structured JSON from our logger.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, logger),
    {
      bodyParser: false,
      // Webhook signatures are verified against the exact bytes received.
      rawBody: true,
      logger: false,
    },
  );
  app.use(requestContext(logger));
  // Only with known proxies: otherwise any client could choose its own rate-limit identity.
  if (config.TRUST_PROXY_HOPS > 0)
    app.set('trust proxy', config.TRUST_PROXY_HOPS);
  // Only checkout and recipient routes accept cross-origin calls, and only from the web app.
  // Only recipient routes allow credentials (the session cookie); checkout never does.
  const webOrigin = new URL(config.WEB_ORIGIN).origin;
  app.enableCors((request, callback) => {
    const url = (request as { url?: string }).url ?? '';
    const credentialed = CREDENTIALED_PATHS.some((path) =>
      url.startsWith(path),
    );
    callback(null, {
      origin:
        credentialed || CROSS_ORIGIN_PATHS.some((path) => url.startsWith(path))
          ? [webOrigin]
          : false,
      methods: credentialed
        ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
        : ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: credentialed
        ? ['content-type', 'x-tipme-csrf', 'idempotency-key']
        : ['content-type', 'authorization', 'idempotency-key'],
      credentials: credentialed,
    });
  });
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  const server = app.getHttpServer() as Server;
  server.requestTimeout = 10_000;
  // Must not exceed requestTimeout to have any effect.
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return app;
}
