import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  FEE_WAIVER_FEE_NAMES,
  FEE_WAIVER_KIND_NAMES,
  opsFeeWaiverSetSchema,
  type AccountFeeSetting,
  type ApiDataResponse,
  type FeeWaiverFeeName,
  type FeeWaiverKindName,
  type OpsAccountFeeWaivers,
  type OpsActedAlone,
  type OpsFeeWaiverCell,
  type OpsFeeWaiverCost,
  type OpsFeeWaiverRule,
  type OpsFeeWaivers,
  type OpsFeeWaiverSetRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  currentEstimateOf,
  estimateFeeWaiverMonthlyCost,
  feeWaiverAccountNames,
  feeWaiverCost,
  feeWaiverFor,
  feeWaiverRules,
  feeWaiversPaused,
  OperationError,
  requestSeriousAction,
  waitingFeeWaiverRequests,
  type FeeWaiverRow,
  type MoneyOwner,
  type SeriousActionServices,
  type WaiverCost,
} from '@tipme/database';
import { lagosMonthStart } from '@tipme/domain';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  CodedHttpException,
  FeeWaiverConfirmException,
} from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { uuidParam } from './actions.controller.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

const costOf = (cost: WaiverCost): OpsFeeWaiverCost => ({
  incomeGivenUpMinor: String(cost.incomeGivenUpMinor),
  cashPaidMinor: String(cost.cashPaidMinor),
});
const NO_COST: OpsFeeWaiverCost = {
  incomeGivenUpMinor: '0',
  cashPaidMinor: '0',
};
const iso = (at: Date | null) => (at === null ? null : at.toISOString());

/**
 * A row that only ends a waiver is no rule (spec §4 step 1 and 2): an account's `inherit` follows
 * the kind-wide rule, a kind-wide `account` is today's default. An account's `account` (opting out
 * of a kind-wide waiver) is a rule.
 */
const changesWhoPays = (row: FeeWaiverRow) =>
  row.scope === 'account' ? row.payer !== 'inherit' : row.payer === 'tipme';

/**
 * Who pays the fees (spec 2026-11-23 §6): the kind-wide grid with this month's cost, the rules in
 * force and upcoming with their cost so far, and one account's settings. Reading is `fees.manage`
 * without a fresh code: rules, handles, business names, reasons, staff ids and totals, nobody's
 * private details. A change is the serious action `fee_waiver.set`: a second person approves (or a
 * lone admin acts alone, with the alert), audited, for new quotes and withdrawals only.
 */
@Controller('v1/ops/fee-waivers')
export class OpsFeeWaiversController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private async rulesOut(
    rows: FeeWaiverRow[],
    now: Date,
    started: boolean,
  ): Promise<OpsFeeWaiverRule[]> {
    const db = this.database.db;
    const pageIds = rows
      .filter((r) => r.scope === 'account' && r.kind === 'individual')
      .map((r) => r.accountId!);
    const businessIds = rows
      .filter((r) => r.scope === 'account' && r.kind === 'business')
      .map((r) => r.accountId!);
    const names = await feeWaiverAccountNames(db, {
      profileIds: pageIds,
      businessIds,
    });
    return Promise.all(
      rows.map(async (row): Promise<OpsFeeWaiverRule> => {
        const page =
          row.scope === 'account' && row.kind === 'individual'
            ? row.accountId
            : null;
        const business =
          row.scope === 'account' && row.kind === 'business'
            ? row.accountId
            : null;
        return {
          id: row.id,
          scope: row.scope,
          kind: row.kind,
          profileId: page,
          businessId: business,
          handle: page === null ? null : (names.handles.get(page) ?? null),
          businessName:
            business === null
              ? null
              : (names.businessNames.get(business) ?? null),
          fee: row.fee,
          payer: row.payer,
          startsAt: row.startsAt.toISOString(),
          endsAt: iso(row.endsAt),
          setBy: row.setBy,
          approvedBy: row.approvedBy,
          reason: row.reason,
          // Cost so far: from the rule's start to now. A rule not started has cost nothing.
          cost: started
            ? costOf(
                await feeWaiverCost(db, {
                  from: row.startsAt,
                  to: now,
                  ruleId: row.id,
                }),
              )
            : NO_COST,
        };
      }),
    );
  }

  private async read(): Promise<OpsFeeWaivers> {
    const db = this.database.db;
    const now = new Date();
    const monthStart = lagosMonthStart(now);
    const [rules, pause, waitingRequestIds, ...kindCosts] = await Promise.all([
      feeWaiverRules(db, { now }),
      feeWaiversPaused(db, { activeProvider: this.config.PAYMENT_PROVIDER }),
      waitingFeeWaiverRequests(db),
      ...FEE_WAIVER_KIND_NAMES.map((kind) =>
        feeWaiverCost(db, { from: monthStart, to: now, kind }),
      ),
    ]);
    const grid = {} as OpsFeeWaivers['grid'];
    const monthCost = {} as OpsFeeWaivers['monthCost'];
    FEE_WAIVER_KIND_NAMES.forEach((kind, i) => {
      monthCost[kind] = costOf(kindCosts[i]!);
      grid[kind] = {} as Record<FeeWaiverFeeName, OpsFeeWaiverCell>;
      for (const fee of FEE_WAIVER_FEE_NAMES)
        grid[kind][fee] = gridCell(rules.inForce, kind, fee);
    });
    const [inForce, upcoming] = await Promise.all([
      this.rulesOut(rules.inForce.filter(changesWhoPays), now, true),
      this.rulesOut(rules.upcoming, now, false),
    ]);
    return {
      grid,
      monthCost,
      tipWaiversPaused: pause.paused,
      inForce,
      upcoming,
      waitingRequestIds,
    };
  }

  /** One account's settings for each fee it has; 404 when the account doesn't exist. */
  private async account(owner: MoneyOwner): Promise<OpsAccountFeeWaivers> {
    const db = this.database.db;
    const now = new Date();
    const isBusiness = 'businessId' in owner;
    const id = isBusiness ? owner.businessId : owner.profileId;
    const names = await feeWaiverAccountNames(db, {
      profileIds: isBusiness ? [] : [id],
      businessIds: isBusiness ? [id] : [],
    });
    if (!(isBusiness ? names.businessNames : names.handles).has(id))
      throw new CodedHttpException(404, 'NOT_FOUND');
    const [rules, cost] = await Promise.all([
      feeWaiverRules(db, { now, filter: { owner } }),
      feeWaiverCost(db, { from: lagosMonthStart(now), to: now, owner }),
    ]);
    const setting = async (
      fee: FeeWaiverFeeName,
    ): Promise<AccountFeeSetting> => {
      // An `inherit` row is no rule (spec §4): the account follows the kind-wide rule.
      const own = rules.inForce.find(
        (row) =>
          row.scope === 'account' && row.fee === fee && changesWhoPays(row),
      );
      const effective = await feeWaiverFor(db, { owner, fee, now });
      return {
        setting: own?.payer ?? 'inherit',
        endsAt: iso(own?.endsAt ?? null),
        effective: effective.payer === 'tipme' ? 'tipme' : 'normal',
        ruleId: own?.id ?? null,
      };
    };
    return {
      // Businesses have no tip fee (spec §2).
      tip: isBusiness ? null : await setting('tip'),
      withdrawal: await setting('withdrawal'),
      monthCost: costOf(cost),
    };
  }

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('fees.manage')
  async state(): Promise<ApiDataResponse<OpsFeeWaivers>> {
    return { data: await this.read() };
  }

  @Get('profiles/:profileId')
  @RateLimit('ops_read')
  @OpsPermission('fees.manage')
  async profile(
    @Param('profileId') profileId: string,
  ): Promise<ApiDataResponse<OpsAccountFeeWaivers>> {
    return {
      data: await this.account({ profileId: uuidParam(profileId) }),
    };
  }

  @Get('businesses/:businessId')
  @RateLimit('ops_read')
  @OpsPermission('fees.manage')
  async business(
    @Param('businessId') businessId: string,
  ): Promise<ApiDataResponse<OpsAccountFeeWaivers>> {
    return {
      data: await this.account({ businessId: uuidParam(businessId) }),
    };
  }

  @Post()
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('fees.manage')
  async change(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsFeeWaiverSetSchema))
    body: OpsFeeWaiverSetRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsFeeWaivers & OpsActedAlone) | OpsSeriousPending>
  > {
    const { reason, ...payload } = body;
    let outcome;
    try {
      outcome = await requestSeriousAction(this.database.db, {
        name: 'fee_waiver.set',
        payload,
        actorId: ops.userId,
        grantId: ops.grantId,
        reason,
        services: this.services,
      });
    } catch (error) {
      throw (await this.withEstimate(error, payload)) ?? error;
    }
    const answer = pendingOr(outcome, response);
    if ('pending' in answer) return { data: answer.pending };
    return {
      data: {
        ...(await this.read()),
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }

  /**
   * A kind-wide TipMe-pays refusal answers with the live estimate, so the screen shows the figure
   * and asks once more: the one the refusal carries when the figure sent had moved, else the
   * estimate now when none was confirmed.
   */
  private async withEstimate(
    error: unknown,
    payload: Omit<OpsFeeWaiverSetRequest, 'reason'>,
  ): Promise<FeeWaiverConfirmException | null> {
    if (
      !(error instanceof OperationError) ||
      error.code !== 'FEE_WAIVER_CONFIRM_REQUIRED' ||
      payload.scope !== 'kind' ||
      payload.payer !== 'tipme'
    )
      return null;
    const moved = currentEstimateOf(error);
    if (moved !== null)
      return new FeeWaiverConfirmException('estimate_moved', String(moved));
    const live = await estimateFeeWaiverMonthlyCost(this.database.db, {
      kind: payload.kind,
      fee: payload.fee,
      now: new Date(),
    });
    return new FeeWaiverConfirmException('confirm_cost', String(live));
  }
}

/**
 * The kind-wide rule in force for one cell. Businesses have no tip fee, so that cell is always the
 * normal rules, whatever is stored (the rules refuse such a row anyway). Giving isn't built, so its
 * cells are not live.
 */
function gridCell(
  inForce: FeeWaiverRow[],
  kind: FeeWaiverKindName,
  fee: FeeWaiverFeeName,
): OpsFeeWaiverCell {
  const live = kind !== 'giving';
  if (kind === 'business' && fee === 'tip')
    return { payer: 'account', ruleId: null, endsAt: null, live };
  const row = inForce.find(
    (r) => r.scope === 'kind' && r.kind === kind && r.fee === fee,
  );
  return {
    payer: row?.payer === 'tipme' ? 'tipme' : 'account',
    ruleId: row?.id ?? null,
    endsAt: iso(row?.endsAt ?? null),
    live,
  };
}
