import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Inject,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { myProfileId, OperationError, resolveSession } from '@tipme/database';
import type { Logger } from '@tipme/observability';
import type { Request, Response } from 'express';
import { readCookie, SESSION_COOKIE } from '../auth/cookies.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import {
  RATE_LIMIT_ROUTE,
  RateLimitedException,
  RateLimitGuard,
} from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { EventStreamResponse } from '../openapi/event-stream.js';
import { LOGGER } from '../tokens.js';
import { LiveHubService } from './live-hub.service.js';
import type { LiveMetrics } from './live-metrics.js';
import {
  sseFrame,
  sseRetry,
  type LiveCloseReason,
  type LiveSink,
} from './live-router.js';

const LIFETIME_MS = 30 * 60_000;
const LIFETIME_JITTER_MS = 3 * 60_000;
/** How long the browser waits before its own reconnect, if it ever uses the built-in one. */
const CLIENT_RETRY_MS = 5000;
const REFUSED_RETRY_AFTER_S = 30;
/**
 * A `: hb` comment for curl and proxies, plus a named `hb` event: EventSource never shows comments
 * to the page, and the client's watchdog must see the heartbeat. A named event never reaches
 * `onmessage`, and its data is empty JSON.
 */
export const HEARTBEAT = ': hb\nevent: hb\ndata: {}\n\n';

/** Shared by /v1/me/events and (later) /v1/ops/events. */
export function openStream(o: {
  req: Request;
  res: Response;
  hub: LiveHubService;
  metrics: LiveMetrics;
  logger: Logger;
  sink: Omit<LiveSink, 'write' | 'close' | 'id'>;
  expiresAt: Date | null;
  /** 30 min ± 3 min. */
  lifetimeMs?: number;
  /** 20 s. */
  heartbeatMs?: number;
}): void {
  const { req, res, hub, metrics } = o;
  let open = true;
  // Started only once the stream is registered; cleared by whichever close comes first.
  const timers: { heartbeat?: NodeJS.Timeout; lifetime?: NodeJS.Timeout } = {};
  const id = randomUUID();

  const finish = (reason: LiveCloseReason) => {
    if (!open) return;
    open = false;
    clearInterval(timers.heartbeat);
    clearTimeout(timers.lifetime);
    hub.unregister(id);
    metrics.close(reason);
    res.end();
  };
  const sink: LiveSink = {
    ...o.sink,
    id,
    write: (frame) => {
      if (open) res.write(frame);
    },
    close: finish,
  };

  const registered = hub.register(sink);
  if (!registered.ok) {
    metrics.connect(registered.reason);
    o.logger.warn({ event: 'live.limit_reached', kind: registered.reason });
    if (registered.reason === 'limit_user')
      throw new CodedHttpException(429, 'LIVE_LIMIT');
    throw new CodedHttpException(
      503,
      'LIVE_UNAVAILABLE',
      undefined,
      REFUSED_RETRY_AFTER_S,
    );
  }
  metrics.connect('opened');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  // Harmless under Caddy; protects against an nginx placed in front later.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const socket = req.socket;
  socket.setTimeout(0);
  socket.setNoDelay(true);
  socket.setKeepAlive(true);

  res.write(sseRetry(CLIENT_RETRY_MS));
  res.write(sseFrame({ type: 'ready' }));
  // This copy can't hear signals right now: the page polls until a resync.
  if (!hub.subscriberUp) res.write(sseFrame({ type: 'poll' }));

  timers.heartbeat = setInterval(() => {
    if (open) res.write(HEARTBEAT);
  }, o.heartbeatMs ?? 20_000);
  const lifetimeMs =
    o.lifetimeMs ??
    LIFETIME_MS + Math.round((Math.random() * 2 - 1) * LIFETIME_JITTER_MS);
  const untilExpiry = o.expiresAt
    ? o.expiresAt.getTime() - Date.now()
    : Infinity;
  timers.lifetime = setTimeout(
    () => finish(untilExpiry <= lifetimeMs ? 'session_ended' : 'lifetime'),
    Math.max(0, Math.min(lifetimeMs, untilExpiry)),
  );
  req.on('close', () => finish('client'));
  res.on('error', () => finish('error'));
}

/** The recipient's signal stream (spec §2.1): types only, never data. */
@Controller('v1/me')
export class LiveController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(LiveHubService) private readonly hub: LiveHubService,
    @Inject(RateLimitGuard) private readonly limits: RateLimitGuard,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get('events')
  @SetMetadata(RATE_LIMIT_ROUTE, 'live_connect')
  // The address limit first, so unauthenticated connects count too.
  @UseGuards(RateLimitGuard, SessionGuard)
  @EventStreamResponse({
    description:
      'A text/event-stream of change signals for the signed-in recipient: `retry: 5000`, then ' +
      '`data: {"type":"ready"}`, then `data: {"type":"<signal>"}` lines and a heartbeat (a `: hb` comment and an `hb` event) every ' +
      '20 s. Signals carry only a type, never data; on one, re-read the matching endpoints. ' +
      '204 while live updates are off. 429 LIVE_LIMIT past 8 streams for one person; 503 ' +
      'LIVE_UNAVAILABLE (Retry-After: 30) when this copy is full or stopping.',
  })
  async me(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() auth: AuthContext,
  ): Promise<void> {
    const metrics = this.hub.metrics;
    if (!this.config.LIVE_UPDATES_ENABLED) {
      metrics.connect('disabled');
      res.status(204).end();
      return;
    }
    try {
      await this.limits.consumeForPerson('live_connect_user', auth.userId);
    } catch (error) {
      if (error instanceof RateLimitedException)
        metrics.connect('rate_limited');
      throw error;
    }
    const db = this.database.db;
    // Someone without a page yet still gets a stream: it is indexed by user alone.
    const profileId = await myProfileId(db, auth.userId).catch(
      (error: unknown) => {
        if (error instanceof OperationError && error.code === 'NO_PAGE')
          return null;
        throw error;
      },
    );
    // Kept in this closure only, to re-check this stream's own session; never logged.
    const token = readCookie(req, SESSION_COOKIE) ?? '';
    const userId = auth.userId;
    openStream({
      req,
      res,
      hub: this.hub,
      metrics,
      logger: this.logger,
      expiresAt: auth.expiresAt ?? null,
      heartbeatMs: this.config.LIVE_HEARTBEAT_MS,
      sink: {
        kind: 'me',
        userId,
        profileId,
        permissions: null,
        recheck: async () => {
          const session = await resolveSession(db, token, new Date());
          return session?.userId === userId;
        },
      },
    });
  }
}
