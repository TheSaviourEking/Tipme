import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  insightsQuerySchema,
  shareAmountsSchema,
  type ApiDataResponse,
  type BusinessNoteView,
  type InsightsQuery,
  type LocationInsights,
  type MyMembership,
  type ShareAmounts,
} from '@tipme/contracts';
import {
  businessNotes,
  locationInsights,
  setShareAmounts,
} from '@tipme/database';
import { lagosWeekRange } from '@tipme/domain';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/** `2026-W54` has the right shape and is no week: refused as `week`, never read as empty. */
const insightsQueryPipe = new ZodValidationPipe(
  insightsQuerySchema.refine((query) => lagosWeekRange(query.week) !== null, {
    path: ['week'],
  }),
);

/**
 * PR B7, what the business sees: one location's week (counts in groups of 3 or more, no naira
 * unless the person shares them) and the notes customers wrote, for a manager of that location;
 * and the person's own choice to share their weekly amounts. Another business's id, or a location
 * the manager doesn't manage, answers 404 (access-control rule 2).
 */
@Controller('v1/me')
@UseGuards(BusinessEnabledGuard, SessionGuard)
export class BusinessInsightsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get('businesses/:id/insights')
  @Header('Cache-Control', 'private, no-store')
  async insights(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Query(insightsQueryPipe) query: InsightsQuery,
  ): Promise<ApiDataResponse<LocationInsights>> {
    return {
      data: await locationInsights(
        this.database.db,
        auth.userId,
        businessId,
        query,
      ),
    };
  }

  @Get('businesses/:id/notes')
  @Header('Cache-Control', 'private, no-store')
  async notes(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Query(insightsQueryPipe) query: InsightsQuery,
  ): Promise<ApiDataResponse<BusinessNoteView[]>> {
    return {
      data: await businessNotes(
        this.database.db,
        auth.userId,
        businessId,
        query,
      ),
    };
  }

  @Patch('work/:memberId/share-amounts')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  async shareAmounts(
    @CurrentUser() auth: AuthContext,
    @Param('memberId') memberId: string,
    @Body(new ZodValidationPipe(shareAmountsSchema)) body: ShareAmounts,
  ): Promise<ApiDataResponse<MyMembership>> {
    return {
      data: await setShareAmounts(
        this.database.db,
        auth.userId,
        memberId,
        body.share,
      ),
    };
  }
}
