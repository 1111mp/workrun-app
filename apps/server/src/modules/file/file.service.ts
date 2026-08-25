import { extname } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import { md5 } from '../../utils/file.util';
import { sanitize } from '../../utils/xss.util';
import { FS_STATIC_SERVICE } from '../fs/fs.constant';
import type { CommonFSService } from '../fs/types';

@Injectable()
export class FileService {
  constructor(
    @Inject(FS_STATIC_SERVICE) private readonly staticFS: CommonFSService,
  ) {}

  async uploadStaticFile(
    file: Express.Multer.File,
    scope: string,
    filename: string,
  ) {
    const fileMD5 = md5(file.buffer);

    this.sanitizeFile(file);

    const fileData = await this.staticFS.write(scope, filename, file.buffer, {
      mimetype: file.mimetype,
      md5: fileMD5,
      referrer: scope,
    });
    return fileData.url;
  }

  async readStatic(scope: string, filename: string, resp: Response) {
    const fileData = await this.staticFS.getMetaDataByName(scope, filename);
    const stream = await this.staticFS.readByName(scope, filename);

    if (fileData.contentType) {
      resp.setHeader('Content-Type', fileData.contentType);
    }

    stream.pipe(resp);
  }

  /**
   * Remove malicious code
   * @param file Express.Multer.File
   */
  sanitizeFile(file: Express.Multer.File) {
    const ext = extname(file.originalname);

    if (
      ['.svg', '.html', '.xml'].includes(ext) ||
      file.mimetype === 'image/svg+xml' ||
      file.mimetype === 'text/html'
    ) {
      file.buffer = Buffer.from(sanitize(file.buffer.toString()));
    }
  }
}
