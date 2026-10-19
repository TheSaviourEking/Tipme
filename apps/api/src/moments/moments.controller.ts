import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ApiDataResponse, MomentView } from '@tipme/contracts';
import { listMoments, myProfileId, shareMoment } from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';

/** The recipient's moments, and sharing one on their public page (it is private until then). */
@Controller('v1/me/moments')
@UseGuards(SessionGuard, CsrfGuard)
export class MomentsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MomentView[]>> {
    return {
      data: await listMoments(
        this.database.db,
        await myProfileId(this.database.db, auth.userId),
      ),
    };
  }

  @Post(':id/share')
  @HttpCode(204)
  async share(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<void> {
    const shared = await shareMoment(this.database.db, auth.userId, id);
    if (!shared) throw new NotFoundException();
    this.revalidator.revalidate(shared.handle);
  }
}

@Module({
  imports: [ProfilesModule],
  controllers: [MomentsController],
  providers: [SessionGuard, CsrfGuard],
})
export class MomentsModule {}
