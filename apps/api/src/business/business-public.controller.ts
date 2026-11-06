import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  businessPeopleQuerySchema,
  type ApiDataResponse,
  type BusinessPeopleQuery,
  type BusinessPersonMatch,
  type PublicLocation,
  type PublicStaffTipPage,
  type StaffPageRedirect,
} from '@tipme/contracts';
import {
  publicLocation,
  publicStaffTipPage,
  searchBusinessPeople,
  type PublicReadOptions,
} from '@tipme/database';
import { bachsEnvironment, liveCheckoutOpenFor } from '@tipme/payments';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * PR B4: the public reads behind a location code and a staff code (`/b/<business>/<location>` and
 * `/b/<business>/<location>/<handle>` on the web, which caches them). Only the search is
 * rate-limited: it is the one a roster could be scraped through.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessPublicController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** The same rule as the person's own page: tips through Bachs need their own ready account. */
  private options(): PublicReadOptions {
    const environment = bachsEnvironment(this.config.PAYMENT_PROVIDER);
    return environment
      ? { requiredAccount: { provider: 'bachs', environment } }
      : {};
  }

  // Declared before `:business/:location`, so `people` is never read as a location's slug.
  /** "I don't see them": at least 2 characters of a name, across the business's open locations. */
  @Get('b/:business/people')
  @RateLimit('business_public')
  @Header('Cache-Control', 'no-store')
  async search(
    @Param('business') business: string,
    @Query(new ZodValidationPipe(businessPeopleQuerySchema))
    query: BusinessPeopleQuery,
  ): Promise<ApiDataResponse<BusinessPersonMatch[]>> {
    return {
      data: await searchBusinessPeople(
        this.database.db,
        business,
        query.q,
        this.options(),
      ),
    };
  }

  @Get('b/:business/:location')
  @Header('Cache-Control', 'no-store')
  async location(
    @Param('business') business: string,
    @Param('location') location: string,
  ): Promise<ApiDataResponse<PublicLocation>> {
    const page = await publicLocation(
      this.database.db,
      business,
      location,
      this.options(),
    );
    if (!page) throw new NotFoundException();
    return { data: page };
  }

  /** A staff code. Someone no longer working here answers `{ redirectTo }`: their own page (M2). */
  @Get('b/:business/:location/:handle')
  @Header('Cache-Control', 'no-store')
  async staff(
    @Param('business') business: string,
    @Param('location') location: string,
    @Param('handle') handle: string,
  ): Promise<ApiDataResponse<PublicStaffTipPage | StaffPageRedirect>> {
    const page = await publicStaffTipPage(
      this.database.db,
      business,
      location,
      handle,
      this.options(),
    );
    if (!page) throw new NotFoundException();
    if ('redirectTo' in page) return { data: page };
    return {
      data: {
        ...page,
        profile: {
          ...page.profile,
          tippingOpen: liveCheckoutOpenFor(
            this.config,
            page.profile.handle.toLowerCase(),
          ),
        },
      },
    };
  }
}
