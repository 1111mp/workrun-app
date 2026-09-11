import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';

import { BetterAuthUser } from '../user/schemas/better-auth-user.schema';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { ListWorkflowOverviewDto } from './dto/list-workflow-overview.dto';
import { PublishWorkflowDto } from './dto/publish-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import {
  WorkflowRelease,
  type WorkflowReleaseDocument,
} from './schemas/workflow-release.schema';
import { Workflow, type WorkflowDocument } from './schemas/workflow.schema';

@Injectable()
export class WorkflowService {
  constructor(
    @InjectModel(Workflow.name)
    private readonly workflowModel: Model<WorkflowDocument>,
    @InjectModel(WorkflowRelease.name)
    private readonly workflowReleaseModel: Model<WorkflowReleaseDocument>,
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

  async publish(ownerId: string, id: string, dto: PublishWorkflowDto) {
    const workflow = await this.getOwnedWorkflow(ownerId, id);
    const version = dto.version.trim();
    this.validatePublishableDocument(workflow.document);

    try {
      const release = await this.workflowReleaseModel.create({
        id: randomUUID(),
        workflowId: workflow.id,
        version,
        releaseNote: dto.releaseNote.trim(),
        document: workflow.document,
        publishedAt: new Date(),
      });
      await this.workflowModel.updateOne(
        { _id: workflow._id },
        { latestReleaseId: release._id, status: 'published' },
      );
      return release;
    } catch (error) {
      // The unique compound index prevents concurrent publishes from claiming
      // the same semantic version.
      if (this.isDuplicateKey(error)) {
        throw new ConflictException(`Workflow ${id}@${version} already exists`);
      }
      throw error;
    }
  }

  async findReleases(ownerId: string, id: string) {
    await this.getOwnedWorkflow(ownerId, id);
    return this.workflowReleaseModel
      .find({ workflowId: id })
      .sort({ publishedAt: -1 })
      .lean();
  }

  async findPublishedCatalog(_viewerId: string) {
    const workflows = await this.workflowModel
      .find({ isDelete: false, latestReleaseId: { $ne: null } })
      .sort({ updatedAt: -1 })
      .populate<{ latestReleaseId: WorkflowRelease }>({
        path: 'latestReleaseId',
      })
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();
    return workflows.map((workflow) => this.publishedDefinition(workflow));
  }

  async findOverview(viewerId: string, query: ListWorkflowOverviewDto = {}) {
    const ownerId = this.toOwnerId(viewerId);
    const workflows = await this.workflowModel
      .find({
        isDelete: false,
        $or: [{ ownerId }, { latestReleaseId: { $ne: null } }],
      })
      .populate<{ latestReleaseId: WorkflowRelease }>({
        path: 'latestReleaseId',
      })
      .lean();

    const filtered = workflows
      .map((workflow) => {
        const editable =
          workflow.ownerId instanceof Types.ObjectId &&
          workflow.ownerId.equals(ownerId);
        const release = workflow.latestReleaseId;
        if (!editable && !release) return null;
        const displayUpdatedAt = editable
          ? workflow.updatedAt
          : release.publishedAt;
        return {
          id: workflow.id,
          document: editable ? workflow.document : release.document,
          editable,
          status: workflow.status,
          latestRelease: release
            ? {
                version: release.version,
                releaseNote: release.releaseNote,
                publishedAt: release.publishedAt,
              }
            : null,
          displayUpdatedAt,
        };
      })
      .filter((workflow): workflow is NonNullable<typeof workflow> =>
        Boolean(workflow),
      )
      .filter((workflow) => {
        if (query.owner === 'mine' && !workflow.editable) return false;
        if (query.owner === 'others' && workflow.editable) return false;
        if (query.status && workflow.status !== query.status) return false;
        if (
          query.version &&
          workflow.latestRelease?.version !== query.version.trim()
        )
          return false;
        const name = workflow.document.settings.name as string;
        return (
          !query.query ||
          name.toLowerCase().includes(query.query.trim().toLowerCase())
        );
      })
      .sort(
        (left, right) =>
          right.displayUpdatedAt.getTime() - left.displayUpdatedAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    const pageSize = query.pageSize ?? 30;
    const cursor = this.parseOverviewCursor(query.cursor);
    const start = cursor
      ? filtered.findIndex(
          (workflow) =>
            workflow.displayUpdatedAt.toISOString() === cursor.updatedAt &&
            workflow.id === cursor.id,
        ) + 1
      : 0;
    if (cursor && start === 0) {
      throw new BadRequestException('Invalid workflow overview cursor');
    }
    const items = filtered.slice(start, start + pageSize);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        start + pageSize < filtered.length && last
          ? Buffer.from(
              JSON.stringify({
                id: last.id,
                updatedAt: last.displayUpdatedAt.toISOString(),
              }),
            ).toString('base64url')
          : undefined,
    };
  }

  async findPublished(_viewerId: string, id: string) {
    const workflow = await this.workflowModel
      .findOne({ id, isDelete: false, latestReleaseId: { $ne: null } })
      .populate<{ latestReleaseId: WorkflowRelease }>({
        path: 'latestReleaseId',
      })
      .populate<{ ownerId: BetterAuthUser }>({
        path: 'ownerId',
        select: 'name email emailVerified image createdAt updatedAt',
      })
      .lean();
    if (!workflow?.latestReleaseId) {
      throw new NotFoundException(`Published Workflow ${id} was not found`);
    }
    return this.publishedDefinition(workflow);
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

  private async getOwnedWorkflow(ownerId: string, id: string) {
    const workflow = await this.workflowModel
      .findOne({ id, ownerId: this.toOwnerId(ownerId), isDelete: false })
      .lean();
    if (!workflow) throw new NotFoundException(`Workflow ${id} was not found`);
    return workflow;
  }

  private publishedDefinition(workflow: {
    id: string;
    createdAt: Date;
    ownerId: BetterAuthUser;
    latestReleaseId: WorkflowRelease;
  }) {
    const release = workflow.latestReleaseId;
    return {
      id: workflow.id,
      ownerId: workflow.ownerId,
      createdAt: workflow.createdAt,
      updatedAt: release.publishedAt,
      publishedAt: release.publishedAt,
      version: release.version,
      releaseId: release.id,
      releaseNote: release.releaseNote,
      document: release.document,
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

  private parseOverviewCursor(cursor?: string) {
    if (!cursor) return undefined;
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
        id?: unknown;
        updatedAt?: unknown;
      };
      if (
        typeof value.id !== 'string' ||
        typeof value.updatedAt !== 'string' ||
        Number.isNaN(Date.parse(value.updatedAt))
      ) {
        throw new Error('invalid cursor');
      }
      return { id: value.id, updatedAt: value.updatedAt };
    } catch {
      throw new BadRequestException('Invalid workflow overview cursor');
    }
  }

  private validatePublishableDocument(document: {
    nodes: unknown[];
    edges: unknown[];
    settings: Record<string, unknown>;
  }) {
    const nodeIds = new Set<string>();
    for (const node of document.nodes) {
      if (
        !node ||
        typeof node !== 'object' ||
        !('id' in node) ||
        typeof node.id !== 'string' ||
        !node.id.trim() ||
        nodeIds.has(node.id)
      ) {
        throw new BadRequestException(
          'Workflow nodes must have unique, non-empty IDs',
        );
      }
      nodeIds.add(node.id);
    }

    for (const edge of document.edges) {
      if (
        !edge ||
        typeof edge !== 'object' ||
        !('source' in edge) ||
        !('target' in edge) ||
        typeof edge.source !== 'string' ||
        typeof edge.target !== 'string' ||
        !nodeIds.has(edge.source) ||
        !nodeIds.has(edge.target)
      ) {
        throw new BadRequestException(
          'Workflow edges must connect existing nodes',
        );
      }
    }
  }
}
