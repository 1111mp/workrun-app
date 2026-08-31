import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';

import { BetterAuthUser } from '../user/schemas/better-auth-user.schema';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { Workflow, type WorkflowDocument } from './schemas/workflow.schema';

@Injectable()
export class WorkflowService {
  constructor(
    @InjectModel(Workflow.name)
    private readonly workflowModel: Model<WorkflowDocument>,
  ) {}

  create(ownerId: string, dto: CreateWorkflowDto) {
    return this.workflowModel.create({
      ...dto,
      id: randomUUID(),
      ownerId: this.toOwnerId(ownerId),
    });
  }

  findAll(ownerId: string) {
    return this.workflowModel
      .find({ ownerId: this.toOwnerId(ownerId), isDelete: false })
      .sort({ updatedAt: -1 })
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();
  }

  async findOne(ownerId: string, id: string) {
    const workflow = await this.workflowModel
      .findOne({ id, ownerId: this.toOwnerId(ownerId), isDelete: false })
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();
    if (!workflow) throw new NotFoundException(`Workflow ${id} was not found`);
    return workflow;
  }

  async update(ownerId: string, id: string, dto: UpdateWorkflowDto) {
    const workflow = await this.workflowModel
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
    if (!workflow) throw new NotFoundException(`Workflow ${id} was not found`);
    return workflow;
  }

  async remove(ownerId: string, id: string) {
    const workflow = await this.workflowModel
      .findOneAndUpdate(
        { id, ownerId: this.toOwnerId(ownerId), isDelete: false },
        { isDelete: true, deletedAt: new Date() },
        { new: true },
      )
      .lean();
    if (!workflow) throw new NotFoundException(`Workflow ${id} was not found`);
    return workflow;
  }

  private toOwnerId(ownerId: string) {
    return new Types.ObjectId(ownerId);
  }
}
