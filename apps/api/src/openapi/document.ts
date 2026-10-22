import 'reflect-metadata';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { ModulesContainer } from '@nestjs/core';
import { apiErrorCodes } from '@tipme/contracts';
import { z } from 'zod';
import { createApp } from '../app.factory.js';
import { SessionGuard } from '../auth/session.guard.js';
import { loadApiConfig } from '../config.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { OPS_PERMISSION, OpsGuard } from '../ops/ops.guard.js';

// OpenAPI 3.1 (PR-011, PRD §8), generated from what Nest actually registers: each controller's
// paths and methods, the guards that require a session, the admin permission, and the zod schema
// each validation pipe holds. Nothing is written by hand, so the document cannot drift.

/** Modules that exist only while payments and messages are pretend (mock providers, dev tools). */
const PRETEND_ONLY = new Set([
  'PretendInboxModule',
  'DiagnosticsModule',
  'MockCheckoutModule',
  'WebhooksModule',
]);

type Json = Record<string, unknown>;
type Handler = (...args: unknown[]) => unknown;

const join = (...parts: string[]) =>
  `/${parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/')}`;

/** The schema a ZodValidationPipe holds (its constructor argument). */
function pipeSchema(pipes: unknown[] | undefined): z.ZodType | undefined {
  const pipe = pipes?.find((p) => p instanceof ZodValidationPipe) as
    { schema: z.ZodType } | undefined;
  return pipe?.schema;
}

function jsonSchema(schema: z.ZodType): Json {
  const result = z.toJSONSchema(schema, {
    unrepresentable: 'any',
    io: 'input',
  }) as Json;
  // The document's own dialect applies; a per-schema $schema would only repeat it.
  delete result['$schema'];
  return result;
}

function operation(
  controller: { name: string },
  handler: Handler,
  method: string,
  path: string,
  pretend: boolean,
  variant: number,
): Json {
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
  ];
  const session = guards.some((g) => g === SessionGuard || g === OpsGuard);
  const permission = Reflect.getMetadata(OPS_PERMISSION, handler) as
    string | undefined;
  const args = Object.entries(
    (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      controller,
      handler.name,
    ) as Record<string, { data?: unknown; pipes?: unknown[] }>) ?? {},
  );
  const of = (type: RouteParamtypes) =>
    args.filter(([key]) => key.split(':')[0] === String(type));

  const parameters: Json[] = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  for (const [, query] of of(RouteParamtypes.QUERY)) {
    const schema = pipeSchema(query.pipes);
    if (!schema) continue;
    const shape = jsonSchema(schema) as {
      properties?: Record<string, Json>;
      required?: string[];
    };
    for (const [name, property] of Object.entries(shape.properties ?? {}))
      parameters.push({
        name,
        in: 'query',
        required: shape.required?.includes(name) ?? false,
        schema: property,
      });
  }
  const bodySchema = of(RouteParamtypes.BODY)
    .map(([, body]) => pipeSchema(body.pipes))
    .find(Boolean);

  const status =
    (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ??
    (method === 'post' ? 201 : 200);
  const tag = controller.name.replace(/Controller$/, '');
  return {
    operationId: `${tag}.${handler.name}${variant > 0 ? `_${variant + 1}` : ''}`,
    tags: pretend ? [tag, 'pretend only'] : [tag],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(bodySchema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchema(bodySchema) } },
          },
        }
      : {}),
    responses: {
      [String(status)]:
        status === 204
          ? { description: 'Done; no body.' }
          : {
              description: 'Success.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DataResponse' },
                },
              },
            },
      default: {
        description:
          'An error with a stable code; never echoes request values.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
    },
    ...(session ? { security: [{ session: [] }] } : {}),
    ...(permission ? { 'x-tipme-permission': permission } : {}),
  };
}

export function buildOpenApi(app: INestApplication): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const module of app.get(ModulesContainer).values()) {
    const pretend = PRETEND_ONLY.has(module.metatype.name);
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as unknown as {
        name: string;
        prototype: Record<string, unknown>;
      };
      const bases = [
        (Reflect.getMetadata(PATH_METADATA, controller) as
          string | string[] | undefined) ?? '',
      ].flat();
      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[key];
        if (typeof handler !== 'function' || key === 'constructor') continue;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (verb === undefined) continue;
        const method = RequestMethod[verb].toLowerCase();
        const own = [
          (Reflect.getMetadata(PATH_METADATA, handler) as
            string | string[] | undefined) ?? '',
        ].flat();
        // A handler on several paths (e.g. /health and /health/live) gets one id per path.
        let variant = 0;
        for (const base of bases)
          for (const sub of own) {
            const path = join(base, sub).replace(/:(\w+)/g, '{$1}');
            (paths[path] ??= {})[method] = operation(
              controller,
              handler as Handler,
              method,
              path,
              pretend,
              variant++,
            );
          }
      }
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(paths)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, item]) => [
        path,
        Object.fromEntries(Object.entries(item).sort()),
      ]),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'TipMe API',
      version: '1',
      description:
        'Generated from the running API (pnpm api:openapi). Money is integer minor units as strings plus an ISO currency. Payments are pretend until the processor and funds flow are approved.',
    },
    paths: sorted,
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'tipme_session',
          description:
            'The recipient or staff session. Changes also need the x-tipme-csrf header.',
        },
      },
      schemas: {
        DataResponse: {
          type: 'object',
          required: ['data'],
          properties: { data: {} },
        },
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'reference'],
              properties: {
                code: { type: 'string', enum: [...apiErrorCodes] },
                message: { type: 'string' },
                reference: { type: 'string' },
                fields: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * The API with every module on (pretend payments and messages, diagnostics), for generating the
 * document. Placeholder secrets only; local Postgres and Redis defaults.
 */
export async function createOpenApiApp(): Promise<INestApplication> {
  const app = await createApp(
    loadApiConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL:
        process.env['DATABASE_URL'] ??
        'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local',
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
      DIAGNOSTICS_ENABLED: 'true',
      MOCK_PROVIDER_WEBHOOK_SECRET: 'openapi-placeholder-secret-32-characters',
      STATUS_TOKEN_SECRET: 'openapi-placeholder-secret-32-characters',
      AUTH_CODE_SECRET: 'openapi-placeholder-secret-32-characters',
      WEB_REVALIDATE_SECRET: 'openapi-placeholder-secret-32-characters',
      OPS_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'),
    }),
  );
  await app.init();
  return app;
}
