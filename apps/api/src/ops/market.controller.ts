import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  marketEntryPatchSchema,
  marketEntrySchema,
  marketListQuerySchema,
  marketSeriesQuerySchema,
  type ApiDataResponse,
  type MarketEntry,
  type MarketEntryInput,
  type MarketEntryPatch,
} from '@tipme/contracts';
import {
  addMarketEntry,
  archiveMarketEntry,
  listMarketEntries,
  marketSeries,
  updateMarketEntry,
} from '@tipme/database';
import type { z } from 'zod';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/** Outside observations recorded by hand (automatic feeds come later; see 00-DECISIONS). */
@Controller('v1/ops/market')
export class OpsMarketController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @OpsPermission('analytics.view')
  async list(
    @Query(new ZodValidationPipe(marketListQuerySchema))
    query: z.infer<typeof marketListQuerySchema>,
  ): Promise<ApiDataResponse<MarketEntry[]>> {
    return { data: await listMarketEntries(this.database.db, query) };
  }

  @Get('series')
  @OpsPermission('analytics.view')
  async series(
    @Query(new ZodValidationPipe(marketSeriesQuerySchema))
    query: z.infer<typeof marketSeriesQuerySchema>,
  ): Promise<ApiDataResponse<{ observedOn: string; value: number }[]>> {
    return { data: await marketSeries(this.database.db, query) };
  }

  @Post()
  @HttpCode(201)
  @OpsPermission('market.edit')
  async add(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(marketEntrySchema)) entry: MarketEntryInput,
  ): Promise<ApiDataResponse<MarketEntry>> {
    return {
      data: await addMarketEntry(this.database.db, {
        entry,
        staffUserId: ops.userId,
      }),
    };
  }

  @Patch(':id')
  @OpsPermission('market.edit')
  async update(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(marketEntryPatchSchema))
    patch: MarketEntryPatch,
  ): Promise<ApiDataResponse<MarketEntry>> {
    return {
      data: await updateMarketEntry(this.database.db, {
        id,
        patch,
        staffUserId: ops.userId,
      }),
    };
  }

  @Post(':id/archive')
  @HttpCode(200)
  @OpsPermission('market.edit')
  async archive(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<MarketEntry>> {
    return {
      data: await archiveMarketEntry(this.database.db, {
        id,
        staffUserId: ops.userId,
      }),
    };
  }
}
