import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';

import { BetterAuthUser } from '../user/schemas/better-auth-user.schema';
import { CreateAppDto } from './dto/create-app.dto';
import { ListAppsDto } from './dto/list-apps.dto';
import { UpdateAppDto } from './dto/update-app.dto';
import { App, type AppDocument } from './schemas/app.schema';

@Injectable()
export class AppService {
  constructor(
    @InjectModel(App.name) private readonly appModel: Model<AppDocument>,
  ) {}

  create(ownerId: string, dto: CreateAppDto) {
    return this.appModel.create({
      ...dto,
      id: randomUUID(),
      ownerId: this.toOwnerId(ownerId),
    });
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
}
