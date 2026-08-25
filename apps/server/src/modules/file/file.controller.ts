import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth } from '@nestjs/swagger';
import type { Response } from 'express';

import { FileService } from './file.service';

@Controller('file')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @ApiCookieAuth('sessionCookie')
  @ApiBearerAuth('bearerAuth')
  @Get('static/:scope/*filename')
  async readStatic(
    @Param('scope') scope: string,
    @Param('filename') filename: string[],
    @Res() resp: Response,
  ) {
    return this.fileService.readStatic(scope, filename.join('/'), resp);
  }
}
