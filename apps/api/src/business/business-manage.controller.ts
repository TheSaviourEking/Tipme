import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  businessApplicationSchema,
  businessUpdateSchema,
  locationInputSchema,
  locationUpdateSchema,
  type ApiDataResponse,
  type BusinessApplication,
  type BusinessDetail,
  type BusinessUpdate,
  type LocationInput,
  type LocationUpdate,
  type ManagerRow,
} from '@tipme/contracts';
import {
  addLocation,
  applyForBusiness,
  businessDetail,
  closeLocation,
  listManagers,
  markVerifiedSeen,
  removeManager,
  updateBusiness,
  updateLocation,
} from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { BusinessSignupEnabledGuard } from './business-signup.guard.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { signalBusiness } from './business-live.js';

/**
 * Lane B1 (PR B1): apply for a business, edit it, its locations and its managers. Signed in, under
 * `/v1/me/` (the only place the API takes the web app's cookies); every write needs CSRF. A
 * business someone doesn't manage answers 404 exactly like an unknown one (rule 2). Adding a
 * manager is an invitation (lane B3); this lane lists and removes them.
 */
@Controller('v1/me/businesses')
@UseGuards(BusinessEnabledGuard, SessionGuard, CsrfGuard)
export class BusinessManageController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    // Optional: integration tests may build this controller without the live module.
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  /** Anyone signed in with a proven email (owner's answer Q3). Pending until TipMe verifies it. */
  @Post()
  @HttpCode(201)
  @RateLimit('business_apply')
  async apply(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(businessApplicationSchema))
    body: BusinessApplication,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    return {
      data: await applyForBusiness(this.database.db, auth.userId, body),
    };
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async detail(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    return {
      data: await businessDetail(this.database.db, auth.userId, id, {
        celebrate: this.config.BUSINESS_SIGNUP_ENABLED,
      }),
    };
  }

  /** Business sign-up (R19): the "verified" moment was seen. Idempotent. */
  @Post(':id/verified-seen')
  @HttpCode(204)
  @UseGuards(BusinessSignupEnabledGuard)
  async verifiedSeen(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<void> {
    await markVerifiedSeen(this.database.db, auth.userId, id);
  }

  /** Owners. The address (slug) changes only while the business waits to be verified. */
  @Patch(':id')
  async update(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(businessUpdateSchema)) body: BusinessUpdate,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    const data = await updateBusiness(this.database.db, auth.userId, id, body);
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
    return { data };
  }

  /** Owners. */
  @Post(':id/locations')
  @HttpCode(201)
  async addLocation(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(locationInputSchema)) body: LocationInput,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    const data = await addLocation(this.database.db, auth.userId, id, body);
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
    return { data };
  }

  /** Owners, or that location's manager. */
  @Patch(':id/locations/:locationId')
  async updateLocation(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Body(new ZodValidationPipe(locationUpdateSchema)) body: LocationUpdate,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    const data = await updateLocation(
      this.database.db,
      auth.userId,
      id,
      locationId,
      body,
    );
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
    return { data };
  }

  /** Owners. The location page stops showing; the people there stay on the team. */
  @Post(':id/locations/:locationId/close')
  @HttpCode(200)
  async closeLocation(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Param('locationId') locationId: string,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    const data = await closeLocation(
      this.database.db,
      auth.userId,
      id,
      locationId,
    );
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
    return { data };
  }

  @Get(':id/managers')
  @Header('Cache-Control', 'private, no-store')
  async managers(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<ManagerRow[]>> {
    return { data: await listManagers(this.database.db, auth.userId, id) };
  }

  /** Owners. Never the last owner (BUSINESS_LAST_OWNER). */
  @Post(':id/managers/:managerId/remove')
  @HttpCode(204)
  async removeManager(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Param('managerId') managerId: string,
  ): Promise<void> {
    await removeManager(this.database.db, auth.userId, id, managerId);
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
  }
}
