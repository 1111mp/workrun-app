import { Readable, Stream } from 'node:stream';

import {
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Model } from 'mongoose';

import type { MutableFSDocument } from './schemas/mutable-fs.schema';
import type { CommonFSService, FSMetaData } from './types';

const MAX_CONTENT_BYTES = 15 * 1024 * 1024;

export class MutableFSService implements CommonFSService {
  constructor(
    private readonly mutableFSModel: Model<MutableFSDocument>,
    private readonly bucketName: string,
  ) {}

  async getMetaData(scope: string, id: string): Promise<FSMetaData> {
    const data = await this.mutableFSModel
      .findOne({
        _id: id,
        bucketName: this.bucketName,
        scope,
      })
      .select({ content: 0 });
    return this.toMetadata(data, `id ${id}, scope ${scope}`);
  }

  async getMetaDataByName(
    scope: string,
    filename: string,
  ): Promise<FSMetaData> {
    const data = await this.mutableFSModel
      .findOne({
        bucketName: this.bucketName,
        scope,
        filename,
      })
      .select({ content: 0 });
    return this.toMetadata(data, `filename ${filename}, scope ${scope}`);
  }

  async read(id: string): Promise<Stream> {
    const data = await this.mutableFSModel.findOne({
      _id: id,
      bucketName: this.bucketName,
    });
    const file = this.getFile(data, `id ${id}`);
    return Readable.from([file.content]);
  }

  async readByName(scope: string, filename: string): Promise<Stream> {
    const data = await this.mutableFSModel.findOne({
      bucketName: this.bucketName,
      scope,
      filename,
    });
    const file = this.getFile(data, `filename ${filename}, scope ${scope}`);
    return Readable.from([file.content]);
  }

  async write(
    scope: string,
    filename: string,
    content: string | Buffer | Stream,
    extra: FSMetaData['extra'],
  ): Promise<FSMetaData> {
    const text = await this.toText(content);
    const data = await this.mutableFSModel.findOneAndUpdate(
      { bucketName: this.bucketName, scope, filename },
      {
        $set: {
          content: text,
          contentType: extra?.mimetype,
          extra: extra ?? {},
          size: Buffer.byteLength(text),
        },
        $setOnInsert: { bucketName: this.bucketName, scope, filename },
      },
      { new: true, upsert: true },
    );

    if (!data) {
      throw new InternalServerErrorException('Failed to write mutable file');
    }
    return this.toMetadata(data, `filename ${filename}, scope ${scope}`);
  }

  async remove(scope: string, id: string, _referrer?: string): Promise<void> {
    const result = await this.mutableFSModel.deleteOne({
      _id: id,
      bucketName: this.bucketName,
      scope,
    });
    if (!result.deletedCount) {
      throw new NotFoundException(
        `Could not find file with id ${id}, scope ${scope}`,
      );
    }
  }

  async removeByName(
    scope: string,
    filename: string,
    _referrer?: string,
  ): Promise<void> {
    const result = await this.mutableFSModel.deleteOne({
      bucketName: this.bucketName,
      scope,
      filename,
    });
    if (!result.deletedCount) {
      throw new NotFoundException(
        `Could not find file with filename ${filename}, scope ${scope}`,
      );
    }
  }

  async removeFilesByScope(scope: string): Promise<void> {
    await this.mutableFSModel.deleteMany({
      bucketName: this.bucketName,
      scope,
    });
  }

  private getFile(
    data: MutableFSDocument | null,
    identifier: string,
  ): MutableFSDocument {
    if (!data) {
      throw new NotFoundException(`Could not find file with ${identifier}`);
    }
    return data;
  }

  private toMetadata(
    data: MutableFSDocument | null,
    identifier: string,
  ): FSMetaData {
    return this.getFile(data, identifier).toObject({ virtuals: true }).metadata;
  }

  private async toText(content: string | Buffer | Stream): Promise<string> {
    if (typeof content === 'string') {
      this.ensureContentSize(Buffer.byteLength(content));
      return content;
    }
    if (Buffer.isBuffer(content)) {
      this.ensureContentSize(content.length);
      return content.toString('utf8');
    }
    if (!(content instanceof Readable)) {
      throw new UnprocessableEntityException(
        'Mutable file content stream must be readable',
      );
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      this.ensureContentSize(size);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private ensureContentSize(size: number): void {
    if (size > MAX_CONTENT_BYTES) {
      throw new PayloadTooLargeException(
        `Mutable file content cannot exceed ${MAX_CONTENT_BYTES} bytes`,
      );
    }
  }
}
