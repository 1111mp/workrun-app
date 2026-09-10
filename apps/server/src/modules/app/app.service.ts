import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';

import { md5 } from '../../utils/file.util';
import { FS_STATIC_SERVICE } from '../fs/fs.constant';
import type { CommonFSService } from '../fs/types';
import { BetterAuthUser } from '../user/schemas/better-auth-user.schema';
import { CreateAppVersionDto } from './dto/create-app-version.dto';
import { CreateAppDto } from './dto/create-app.dto';
import { ListAppsDto } from './dto/list-apps.dto';
import { UpdateAppDto } from './dto/update-app.dto';
import { UploadAppVersionResourceDto } from './dto/upload-app-version-resource.dto';
import {
  AppResource,
  type AppResourceDocument,
} from './schemas/app-resource.schema';
import {
  AppVersion,
  type AppVersionDocument,
} from './schemas/app-version.schema';
import { App, type AppDocument } from './schemas/app.schema';

const APP_VERSION_RESOURCE_SCOPE = 'app-version';

@Injectable()
export class AppService {
  constructor(
    @InjectModel(App.name) private readonly appModel: Model<AppDocument>,
    @InjectModel(AppVersion.name)
    private readonly appVersionModel: Model<AppVersionDocument>,
    @InjectModel(AppResource.name)
    private readonly appResourceModel: Model<AppResourceDocument>,
    @Inject(FS_STATIC_SERVICE) private readonly staticFS: CommonFSService,
  ) {}

  async create(ownerId: string, dto: CreateAppDto) {
    const owner = this.toOwnerId(ownerId);
    const name = dto.name.trim();
    const version = dto.version ?? '0.1.0';
    const existing = await this.appModel.exists({
      ownerId: owner,
      name,
      version,
      isDelete: false,
    });
    if (existing) {
      throw new ConflictException(`App ${name}@${version} already exists`);
    }

    try {
      return await this.appModel.create({
        ...dto,
        id: randomUUID(),
        name,
        ownerId: owner,
        version,
      });
    } catch (error) {
      // The lookup provides a clear error; the database index closes the
      // concurrent-create race between that lookup and the insert.
      if (this.isDuplicateKey(error)) {
        throw new ConflictException(`App ${name}@${version} already exists`);
      }
      throw error;
    }
  }

  async createVersion(
    ownerId: string,
    appId: string,
    dto: CreateAppVersionDto,
  ) {
    const app = await this.getOwnedApp(ownerId, appId);
    const version = dto.version.trim();
    const sourceArchive = await this.appResourceModel.exists({
      appVersionId: dto.id,
      kind: 'source_archive',
    });
    if (!sourceArchive) {
      throw new NotFoundException(
        `Source archive for App version ${dto.id} was not found`,
      );
    }

    try {
      return await this.appVersionModel.create({
        id: dto.id,
        appId: app.id,
        publishedAt: new Date(),
        status: 'published',
        version,
        definition: this.versionDefinition(app, version),
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        throw new ConflictException(`App ${app.id}@${version} already exists`);
      }
      throw error;
    }
  }

  async hasVersion(ownerId: string, appId: string, version: string) {
    const app = await this.getOwnedApp(ownerId, appId);
    const exists = await this.appVersionModel.exists({
      appId: app.id,
      version: version.trim(),
    });
    return { exists: Boolean(exists) };
  }

  async uploadSourceArchive(
    ownerId: string,
    appId: string,
    appVersionId: string,
    dto: UploadAppVersionResourceDto,
    archive?: Express.Multer.File,
  ) {
    if (!archive) throw new BadRequestException('Source archive is required');

    await this.getOwnedApp(ownerId, appId);
    // Persist the resource first so failed uploads cannot reserve a version
    // number.
    const existing = await this.appResourceModel.exists({
      appVersionId,
      kind: 'source_archive',
    });
    if (existing) {
      throw new ConflictException(
        `App version ${appVersionId} already has a source archive`,
      );
    }

    const sha256 = createHash('sha256').update(archive.buffer).digest('hex');
    if (sha256 !== dto.sha256) {
      throw new BadRequestException('Source archive SHA-256 does not match');
    }

    const filename = `${appVersionId}.${dto.format}`;
    const referrer = `app-version:${appVersionId}`;
    const file = await this.staticFS.write(
      APP_VERSION_RESOURCE_SCOPE,
      filename,
      archive.buffer,
      {
        md5: md5(archive.buffer),
        mimetype: archive.mimetype,
        referrer,
      },
    );

    let resource: AppResourceDocument | undefined;
    try {
      resource = await this.appResourceModel.create({
        id: randomUUID(),
        appVersionId,
        kind: 'source_archive',
        fileId: file.id,
        filename,
        format: dto.format,
        sha256,
        size: archive.size,
        url: file.url,
      });
      return { resource };
    } catch (error) {
      // GridFS is outside this write sequence, so remove its referrer if its
      // resource metadata did not commit.
      if (resource) await this.appResourceModel.deleteOne({ id: resource.id });
      await this.staticFS.remove(APP_VERSION_RESOURCE_SCOPE, file.id, referrer);
      if (this.isDuplicateKey(error)) {
        throw new ConflictException(
          `App version ${appVersionId} already has a source archive`,
        );
      }
      throw error;
    }
  }

  async findAll(ownerId: string, query: ListAppsDto = {}) {
    const pageSize = query.pageSize ?? 30;
    const filter: {
      ownerId: Types.ObjectId;
      isDelete: false;
      $or?: Array<Record<string, unknown>>;
    } = {
      ownerId: this.toOwnerId(ownerId),
      isDelete: false,
    };

    if (query.cursor) {
      const cursor = await this.appModel
        .findOne({ id: query.cursor, ownerId: this.toOwnerId(ownerId) })
        .select('id updatedAt')
        .lean();
      if (!cursor) throw new BadRequestException('Invalid app cursor');

      const { id, updatedAt } = cursor as unknown as {
        id: string;
        updatedAt: Date;
      };
      // The ID tie-breaker keeps page boundaries stable when timestamps match.
      filter.$or = [
        { updatedAt: { $lt: updatedAt } },
        { updatedAt, id: { $lt: id } },
      ];
    }

    const items = await this.appModel
      .find(filter)
      .sort({ updatedAt: -1, id: -1 })
      .limit(pageSize + 1)
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();

    if (items.length <= pageSize) return { items };

    items.pop();
    return {
      items,
      nextCursor: items.at(-1)!.id,
    };
  }

  async findPublishedCatalog(_viewerId: string, query: ListAppsDto = {}) {
    const pageSize = query.pageSize ?? 30;
    let cursorMatch: Record<string, unknown> = {};

    if (query.cursor) {
      const cursor = await this.appVersionModel
        .findOne({ id: query.cursor, status: 'published' })
        .select('id publishedAt')
        .lean();
      if (!cursor?.publishedAt) {
        throw new BadRequestException('Invalid published app cursor');
      }

      // The cursor is a release ID, rather than an App ID: a catalog entry is
      // ordered by its latest immutable release, not by mutable draft metadata.
      cursorMatch = {
        $or: [
          { publishedAt: { $lt: cursor.publishedAt } },
          { publishedAt: cursor.publishedAt, id: { $lt: cursor.id } },
        ],
      };
    }

    const items = await this.appVersionModel.aggregate<{
      id: string;
      appId: string;
      definition: Record<string, unknown>;
      publishedAt: Date;
      app: { createdAt: Date; ownerId: Types.ObjectId };
    }>([
      { $match: { status: 'published' } },
      {
        $lookup: {
          from: this.appModel.collection.name,
          localField: 'appId',
          foreignField: 'id',
          as: 'app',
        },
      },
      { $unwind: '$app' },
      // App.version names the sole catalog release. Historical AppVersion
      // snapshots remain downloadable only through their exact version ID.
      {
        $match: {
          'app.isDelete': false,
          $expr: { $eq: ['$version', '$app.version'] },
          ...cursorMatch,
        },
      },
      { $sort: { publishedAt: -1, id: -1 } },
      { $limit: pageSize + 1 },
    ]);

    const page = items.slice(0, pageSize).map((item) => ({
      ...item.definition,
      id: item.appId,
      createdAt: item.app.createdAt,
      updatedAt: item.publishedAt,
      publishedAt: item.publishedAt,
      catalogVersionId: item.id,
      ownerId: item.app.ownerId.toString(),
    }));

    if (items.length <= pageSize) return { items: page };
    return { items: page, nextCursor: page.at(-1)!.catalogVersionId };
  }

  async findPublishedCatalogApp(_viewerId: string, id: string) {
    const app = await this.appModel.findOne({ id, isDelete: false }).lean();
    const release = app
      ? await this.appVersionModel
          .findOne({ appId: id, version: app.version, status: 'published' })
          .lean()
      : null;
    if (!release || !app)
      throw new NotFoundException(`Published App ${id} was not found`);

    const isOwner = app.ownerId.toString() === _viewerId;
    // Owners need their editable server draft; everyone else receives the
    // immutable release snapshot so unpublished changes stay private.
    return {
      ...(isOwner ? this.appDefinition(app) : release.definition),
      id,
      createdAt: app.createdAt,
      updatedAt: release.publishedAt,
      publishedAt: release.publishedAt,
      catalogVersionId: release.id,
      ownerId: app.ownerId.toString(),
    };
  }

  async readPublishedSourceArchive(_viewerId: string, id: string) {
    const app = await this.appModel.findOne({ id, isDelete: false }).lean();
    if (!app) throw new NotFoundException(`Published App ${id} was not found`);

    // App.version is the authoritative current version. A release is usable
    // only when its immutable source archive exists for that exact version.
    const release = await this.appVersionModel
      .findOne({ appId: id, version: app.version, status: 'published' })
      .lean();
    if (!release) {
      throw new NotFoundException(`Published source for App ${id}@${app.version} was not found`);
    }
    const resource = await this.appResourceModel
      .findOne({ appVersionId: release.id, kind: 'source_archive' })
      .lean();
    if (!resource) {
      throw new NotFoundException(`Published source for App ${id}@${app.version} was not found`);
    }

    return {
      resource,
      // Older AppResource records can contain a UUID-style fileId, while
      // GridFS requires a Mongo ObjectId. The published archive filename is
      // unique per version and remains a compatible lookup key for both.
      stream: await this.staticFS.readByName(
        APP_VERSION_RESOURCE_SCOPE,
        resource.filename,
      ),
    };
  }

  async findOne(ownerId: string, id: string) {
    const app = await this.appModel
      .findOne({ id, ownerId: this.toOwnerId(ownerId), isDelete: false })
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();
    if (!app) throw new NotFoundException(`App ${id} was not found`);
    return app;
  }

  async update(ownerId: string, id: string, dto: UpdateAppDto) {
    const app = await this.appModel
      .findOneAndUpdate(
        { id, ownerId: this.toOwnerId(ownerId), isDelete: false },
        dto,
        { new: true },
      )
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();
    if (!app) throw new NotFoundException(`App ${id} was not found`);
    return app;
  }

  async remove(ownerId: string, id: string) {
    const app = await this.appModel
      .findOneAndUpdate(
        { id, ownerId: this.toOwnerId(ownerId), isDelete: false },
        { isDelete: true, deletedAt: new Date() },
        { new: true },
      )
      .lean();
    if (!app) throw new NotFoundException(`App ${id} was not found`);
    return app;
  }

  private toOwnerId(ownerId: string) {
    return new Types.ObjectId(ownerId);
  }

  private async getOwnedApp(ownerId: string, id: string) {
    const app = await this.appModel
      .findOne({ id, ownerId: this.toOwnerId(ownerId), isDelete: false })
      .lean();
    if (!app) throw new NotFoundException(`App ${id} was not found`);
    return app;
  }

  private versionDefinition(app: App, version: string) {
    return {
      description: app.description,
      entry: app.entry,
      inputs: app.inputs,
      kind: app.kind,
      name: app.name,
      outputs: app.outputs,
      toolExecutionPolicy: app.toolExecutionPolicy,
      toolPermissions: app.toolPermissions,
      toolRiskLevel: app.toolRiskLevel,
      version,
    };
  }

  private appDefinition(app: App) {
    return {
      description: app.description,
      entry: app.entry,
      inputs: app.inputs,
      kind: app.kind,
      name: app.name,
      outputs: app.outputs,
      toolExecutionPolicy: app.toolExecutionPolicy,
      toolPermissions: app.toolPermissions,
      toolRiskLevel: app.toolRiskLevel,
      version: app.version,
    };
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11_000
    );
  }
}
