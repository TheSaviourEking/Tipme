import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import type { Logger } from '@tipme/observability';
import type { Request, Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { LiveHubService } from '../live/live-hub.service.js';
import {
  clientGone,
  countedMetrics,
  openStream,
} from '../live/live.controller.js';
import { sseFrame } from '../live/live-router.js';
import { EventStreamResponse } from '../openapi/event-stream.js';
import { LOGGER } from '../tokens.js';
import {
  RATE_LIMIT_ROUTE,
  RateLimitedException,
  RateLimitGuard,
} from './rate-limit.guard.js';
import {
  FINAL_TIP_STATES,
  ReceiptCheckService,
  scheduleReceiptChecks,
} from './receipt-check.service.js';
import { requireStatusToken } from './status-token.js';

/**
 * A supporter's receipt follows its one tip (addendum §3.6). Authorised by the receipt's status
 * token in the Authorization header, never a cookie or a URL, and refused exactly as the status
 * route refuses (404). It writes `ready`, `tip.changed`, the control messages and heartbeats:
 * never a status, amount, name, id or time.
 */
@Controller('v1/tips')
export class TipLiveController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LiveHubService) private readonly hub: LiveHubService,
    @Inject(RateLimitGuard) private readonly limits: RateLimitGuard,
    @Inject(ReceiptCheckService) private readonly receipt: ReceiptCheckService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get(':tipId/events')
  @EventStreamResponse({
    description:
      "A text/event-stream for one tip's receipt, with the receipt's status token as " +
      '`Authorization: Bearer <token>`: `retry: 5000`, then `data: {"type":"ready"}`, then ' +
      '`data: {"type":"tip.changed"}` whenever the tip moves, and a heartbeat (a `: hb` comment and ' +
      'an `hb` event) every 20 s. On a signal, re-read `GET /v1/tips/{tipId}/status`. The stream ' +
      'ends after 15 minutes, or once the tip is final. 204 while live updates are off, and for a ' +
      'tip that is already paid, declined or cancelled. 404, as the status route, for a missing ' +
      'or wrong token or an unknown tip. 429 past 10 connects per tip in 15 minutes, or past 3 ' +
      'open streams for one tip (LIVE_LIMIT); 503 LIVE_UNAVAILABLE (Retry-After: 30) when this ' +
      'copy is full or stopping.',
  })
  // The address limit first, so connects without a token count too.
  @SetMetadata(RATE_LIMIT_ROUTE, 'live_connect')
  @UseGuards(RateLimitGuard)
  async events(
    @Param('tipId') tipId: string,
    @Headers('authorization') authorization: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const metrics = countedMetrics(this.hub, res);
    // The gate answers 204 first while live updates are off; this stays as a second line.
    if (!this.config.LIVE_UPDATES_ENABLED) {
      metrics.connect('disabled');
      res.status(204).end();
      return;
    }
    // As the status route: its refusals must be indistinguishable from this one's.
    res.setHeader('Cache-Control', 'private, no-store');
    requireStatusToken(this.config.STATUS_TOKEN_SECRET, tipId, authorization);
    const state = await this.receipt.state(tipId);
    // An unknown tip is the same 404, before its tip's allowance is touched (ruling L-R5).
    if (state === null) throw new NotFoundException();
    try {
      await this.limits.consumeForTip(tipId);
    } catch (error) {
      if (error instanceof RateLimitedException)
        metrics.connect('rate_limited');
      throw error;
    }
    if (clientGone(res)) {
      metrics.connect('client_gone');
      return;
    }
    // Nothing more will change: the receipt shows what it read and stops.
    if (FINAL_TIP_STATES.has(state)) {
      metrics.connect('final');
      res.status(204).end();
      return;
    }
    let checks: { stop(): void } | null = null;
    const stream = openStream({
      req,
      res,
      hub: this.hub,
      metrics,
      logger: this.logger,
      expiresAt: null,
      lifetimeMs: this.config.LIVE_TIP_LIFETIME_MS,
      heartbeatMs: this.config.LIVE_HEARTBEAT_MS,
      sink: {
        kind: 'tip',
        tipId,
        // Never a real user id, so no user, profile or broadcast signal can reach it.
        userId: `tip:${tipId}`,
        profileId: null,
        permissions: null,
        // No session to lose: the token is an HMAC of the tip id and cannot be revoked.
        recheck: () => Promise.resolve(true),
      },
      // However the stream ends, its copy stops asking Bachs about the tip.
      onClose: () => checks?.stop(),
    });
    if (!stream || !this.receipt.enabled) return;
    // A connected receipt makes no status reads of its own, so this copy asks Bachs as often as
    // its polling would have (addendum §3.6). Once the tip reads final: one tip.changed, so the
    // receipt reads it at once, then close (ruling L-R6).
    checks = scheduleReceiptChecks({
      check: async () =>
        (await this.receipt.check(tipId)) &&
        FINAL_TIP_STATES.has((await this.receipt.state(tipId)) ?? 'waiting'),
      onFinal: () => {
        stream.write(sseFrame({ type: 'tip.changed' }));
        stream.close('final');
      },
      onError: (error) =>
        // The error's name only: no ids.
        this.logger.warn({
          event: 'live.receipt_check_failed',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      now: Date.now,
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return timer;
      },
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    });
  }
}
