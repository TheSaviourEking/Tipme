import { Controller, Get, Inject } from '@nestjs/common';
import type { ApiDataResponse, OpsDatabaseBudget } from '@tipme/contracts';
import { DatabaseProvider } from '../infra/database.js';
import { OpsPermission } from './permission.decorator.js';

/** The answering copy's share of the database's connections. Staff only: it maps our capacity. */
@Controller('v1/ops/database-budget')
export class OpsDatabaseBudgetController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @OpsPermission('issues.view')
  read(): ApiDataResponse<OpsDatabaseBudget> {
    return { data: this.database.budget.snapshot() };
  }
}
