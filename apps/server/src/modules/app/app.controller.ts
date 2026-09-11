import {
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  Param,
  ParseFilePipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiBody,
} from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import type { Response } from 'express';

import { AppService } from './app.service';
import { CreateAppVersionDto } from './dto/create-app-version.dto';
import { CreateAppDto } from './dto/create-app.dto';
import { ListAppsDto } from './dto/list-apps.dto';
import { UpdateAppDto } from './dto/update-app.dto';
import { UploadAppVersionResourceDto } from './dto/upload-app-version-resource.dto';

@ApiCookieAuth('sessionCookie')
@ApiBearerAuth('bearerAuth')
@Controller('app')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post()
  create(@Session() session: UserSession, @Body() dto: CreateAppDto) {
    return this.appService.create(session.user.id, dto);
  }

  @Post(':id/versions')
  createVersion(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() dto: CreateAppVersionDto,
  ) {
    return this.appService.createVersion(session.user.id, id, dto);
  }

  @Get(':id/versions/:version')
  hasVersion(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    return this.appService.hasVersion(session.user.id, id, version);
  }

  @Post(':id/versions/:versionId/resources/source-archive')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['archive', 'format', 'sha256'],
      properties: {
        archive: { type: 'string', format: 'binary' },
        format: { type: 'string', enum: ['tar.gz'] },
        sha256: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('archive', { limits: { fileSize: 200 * 1024 * 1024 } }),
  )
  uploadSourceArchive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: UploadAppVersionResourceDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new FileTypeValidator({ fileType: /gzip|x-gzip/ })],
      }),
    )
    archive: Express.Multer.File,
  ) {
    return this.appService.uploadSourceArchive(
      session.user.id,
      id,
      versionId,
      dto,
      archive,
    );
  }

  @Get('catalog')
  findPublishedCatalog(
    @Session() session: UserSession,
    @Query() query: ListAppsDto,
  ) {
    return this.appService.findPublishedCatalog(session.user.id, query);
  }

  @Get('catalog/:id')
  findPublishedCatalogApp(
    @Session() session: UserSession,
    @Param('id') id: string,
  ) {
    return this.appService.findPublishedCatalogApp(session.user.id, id);
  }

  @Get('catalog/:id/releases/:releaseId')
  findPublishedCatalogRelease(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('releaseId') releaseId: string,
  ) {
    return this.appService.findPublishedCatalogRelease(
      session.user.id,
      id,
      releaseId,
    );
  }

  @Get('catalog/:id/releases')
  findPublishedCatalogReleases(
    @Session() session: UserSession,
    @Param('id') id: string,
  ) {
    return this.appService.findPublishedCatalogReleases(session.user.id, id);
  }

  /**
   * The catalog's App.version is the current release.  Keep archive lookup on
   * that value so clients never infer a release from publication timestamps.
   */
  @Get('catalog/:id/source-archive')
  async downloadPublishedSourceArchive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const { resource, stream } =
      await this.appService.readPublishedSourceArchive(session.user.id, id);
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader('Content-Length', resource.size);
    response.setHeader('X-Workrun-Sha256', resource.sha256);
    stream.pipe(response);
  }

  @Get('catalog/:id/releases/:releaseId/source-archive')
  async downloadPublishedReleaseSourceArchive(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('releaseId') releaseId: string,
    @Res() response: Response,
  ) {
    const { resource, stream } =
      await this.appService.readPublishedReleaseSourceArchive(
        session.user.id,
        id,
        releaseId,
      );
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader('Content-Length', resource.size);
    response.setHeader('X-Workrun-Sha256', resource.sha256);
    stream.pipe(response);
  }

  @Get()
  findAll(@Session() session: UserSession, @Query() query: ListAppsDto) {
    return this.appService.findAll(session.user.id, query);
  }

  @Get(':id')
  findOne(@Session() session: UserSession, @Param('id') id: string) {
    return this.appService.findOne(session.user.id, id);
  }

  @Patch(':id')
  update(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() dto: UpdateAppDto,
  ) {
    return this.appService.update(session.user.id, id, dto);
  }

  @Delete(':id')
  remove(@Session() session: UserSession, @Param('id') id: string) {
    return this.appService.remove(session.user.id, id);
  }
}
