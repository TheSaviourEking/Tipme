import {
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ApiDataResponse, ShiftState } from '@tipme/contracts';
import {
  endShift,
  startShift,
  type ShiftActor,
  type ShiftChange,
} from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Lane B6: check in and out at a location, by the person (`/v1/me/work/:memberId/shift/*`) or a
 * manager of their location (`/v1/me/businesses/:id/members/:memberId/shift/*`). Anything outside
 * the caller's own membership or scope answers as not found. A change refreshes the business's
 * public pages, so the location page lists who is on shift promptly.
 */
@Controller('v1/me')
@UseGuards(BusinessEnabledGuard, SessionGuard, CsrfGuard)
export class BusinessShiftsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Post('work/:memberId/shift/start')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  startOwn(
    @CurrentUser() auth: AuthContext,
    @Param('memberId') memberId: string,
  ): Promise<ApiDataResponse<ShiftState>> {
    return this.start({ userId: auth.userId, as: 'self' }, memberId);
  }

  @Post('work/:memberId/shift/end')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  endOwn(
    @CurrentUser() auth: AuthContext,
    @Param('memberId') memberId: string,
  ): Promise<ApiDataResponse<ShiftState>> {
    return this.end({ userId: auth.userId, as: 'self' }, memberId);
  }

  @Post('businesses/:id/members/:memberId/shift/start')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  startMember(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('memberId') memberId: string,
  ): Promise<ApiDataResponse<ShiftState>> {
    return this.start(
      { userId: auth.userId, as: 'manager', businessId },
      memberId,
    );
  }

  @Post('businesses/:id/members/:memberId/shift/end')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  endMember(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('memberId') memberId: string,
  ): Promise<ApiDataResponse<ShiftState>> {
    return this.end(
      { userId: auth.userId, as: 'manager', businessId },
      memberId,
    );
  }

  private async start(
    actor: ShiftActor,
    memberId: string,
  ): Promise<ApiDataResponse<ShiftState>> {
    const shift = await startShift(this.database.db, actor, memberId);
    this.refresh(shift);
    return { data: { onShift: true, startedAt: shift.startedAt } };
  }

  private async end(
    actor: ShiftActor,
    memberId: string,
  ): Promise<ApiDataResponse<ShiftState>> {
    this.refresh(await endShift(this.database.db, actor, memberId));
    return { data: { onShift: false } };
  }

  /** After the commit, best effort: a web app that can't be reached never fails the press. */
  private refresh(change: ShiftChange): void {
    if (change.changed)
      this.revalidator.revalidateBusiness(change.businessSlug);
  }
}
