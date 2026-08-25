import { Readable, Stream } from 'node:stream';

import {
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { uniq } from 'lodash-es';
import type { Db, GridFSFile } from 'mongodb';
import { type Connection, SchemaTypes } from 'mongoose';

import { MongoGridFS } from '../../lib/mongo-gridfs';
import type { CommonFSService, FSMetaData } from './types';

export class StaticFSService implements CommonFSService {
  private readonly db: Db;
  private readonly gridFS: MongoGridFS;

  /**
   *
   * @param connection
   * @param bucketName
   * @param redundant
   * @param prefix
   */
  constructor(
    private readonly connection: Connection,
    private readonly bucketName: string,
    private readonly redundant: boolean = false,
    private readonly prefix?: string,
  ) {
    const db = this.connection.db;
    if (!db) {
      throw new Error('Mongoose connection must be open before using GridFS');
    }
    this.db = db;

    if (!redundant) {
      this.db.collection(bucketName).createIndexes([
        {
          key: { md5: 1 },
        },
      ]);
    }
    this.gridFS = new MongoGridFS(this.db, this.bucketName);
  }

  async getMetaData(scope: string, id: string): Promise<FSMetaData> {
    const fileData = await this.gridFS.findById(id);
    return {
      id,
      scope,
      filename: fileData.filename,
      contentType: fileData.metadata?.contentType,
      size: fileData.chunkSize,
      extra: fileData.metadata,
      url: this.getFileUrl(scope, fileData.filename),
    };
  }

  async getMetaDataByName(
    scope: string,
    filename: string,
  ): Promise<FSMetaData> {
    const fileData = await this.gridFS.findOne({
      $and: [
        { filename },
        {
          $or: [{ scope }, { scope: { $exists: false } }],
        },
      ],
    });
    return {
      id: fileData._id.toString(),
      scope: fileData.metadata?.scope,
      filename: fileData.filename,
      contentType: fileData.metadata?.contentType,
      size: fileData.chunkSize,
      extra: fileData.metadata,
      url: this.getFileUrl(scope, fileData.filename),
    };
  }

  async read(id: string): Promise<Stream> {
    return this.gridFS.readFileStream(id);
  }

  async readByName(scope: string, filename: string): Promise<Stream> {
    const metadata = await this.getMetaDataByName(scope, filename);
    return this.gridFS.readFileStream(metadata.id);
  }

  async write(
    scope: string,
    filename: string,
    content: string | Buffer | Stream,
    extra: FSMetaData['extra'],
  ): Promise<FSMetaData> {
    let fileData: GridFSFile | null = null;
    if (!this.redundant) {
      if (!extra?.md5)
        throw new UnprocessableEntityException(
          'write non-redundant gridfs must pass md5',
        );

      if (!extra?.referrer)
        throw new UnprocessableEntityException(
          'write non-redundant gridfs must pass referrer',
        );

      const [existingFile] = await this.gridFS.find({
        md5: extra.md5,
        'metadata.scope': scope,
      });
      fileData = existingFile ?? null;
    }

    if (fileData) {
      const referrers = uniq([
        ...((fileData.metadata?.referrers as string[] | undefined) ?? []),
        ...(extra?.referrer ? [extra.referrer] : []),
      ]);
      await this.updateReferrers(fileData._id.toString(), referrers);
    } else {
      if (content instanceof Buffer) {
        content = Readable.from(content);
      } else if (typeof content === 'string') {
        content = Readable.from([content]);
      } else if (!(content instanceof Readable)) {
        throw new Error(
          'Invalid content type. Expected Buffer, string, or Stream.',
        );
      }

      fileData = await this.gridFS.writeFileStream(content, {
        filename,
        contentType: extra?.mimetype,
        metadata: {
          ...extra,
          scope,
          referrers: extra?.referrer ? [extra.referrer] : [],
        },
      });
    }

    if (!fileData) {
      throw new InternalServerErrorException(
        'GridFS did not return an uploaded file',
      );
    }

    return {
      id: fileData._id.toString(),
      scope,
      filename: fileData.filename,
      contentType: fileData.metadata?.contentType,
      size: fileData.chunkSize,
      extra: fileData.metadata,
      url: this.getFileUrl(scope, fileData.filename),
    };
  }

  async remove(scope: string, id: string, referrer?: string) {
    if (!this.redundant) {
      if (!referrer)
        throw new UnprocessableEntityException(
          'remove file from non-redundant gridfs must pass referrer',
        );

      const metadata = await this.getMetaData(scope, id);
      const referrers = (metadata.extra?.referrers ?? []).filter(
        (item) => item !== referrer,
      );

      if (referrers.length) {
        if (referrers.length !== metadata.extra?.referrers?.length) {
          await this.updateReferrers(id, referrers);
        }
        return;
      }
    }

    const objectId = new SchemaTypes.ObjectId(id);
    await this.db
      .collection(`${this.bucketName}.chunks`)
      .deleteMany({ files_id: objectId });
    await this.db
      .collection(`${this.bucketName}.files`)
      .deleteOne({ _id: objectId });
  }

  async removeByName(
    scope: string,
    filename: string,
    referrer?: string,
  ): Promise<void> {
    const metadata = await this.getMetaDataByName(scope, filename);
    return this.remove(scope, metadata.id, referrer);
  }

  async removeFilesByScope(scope: string) {
    const list = await this.gridFS.find({ 'metadata.scope': scope });
    const failures: { fileId: string; error: unknown }[] = [];
    for (const item of list) {
      try {
        await this.db
          .collection(`${this.bucketName}.chunks`)
          .deleteMany({ files_id: item._id });
        await this.db
          .collection(`${this.bucketName}.files`)
          .deleteOne({ _id: item._id });
      } catch (error) {
        failures.push({ fileId: item._id.toString(), error });
      }
    }

    if (failures.length) {
      const fileIds = failures.map(({ fileId }) => fileId).join(', ');
      throw new InternalServerErrorException(
        `Failed to remove ${failures.length} GridFS file(s): ${fileIds}`,
        {
          cause: new AggregateError(
            failures.map(({ error }) => error),
            'GridFS file removal failures',
          ),
        },
      );
    }

    return;
  }

  private async updateReferrers(id: string, referrers: string[]) {
    await this.db
      .collection(`${this.bucketName}.files`)
      .updateOne(
        { _id: new SchemaTypes.ObjectId(id) },
        { $set: { 'metadata.referrers': referrers } },
      );
  }

  private getFileUrl(scope: string, filename: string) {
    if (!this.prefix) {
      return;
    }
    return `${this.prefix}/${scope}/${filename}`;
  }
}
