import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

import { WorkflowService } from './workflow.service';

describe('WorkflowService', () => {
  const ownerId = '507f191e810c19729de860ea';
  const model = {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    updateOne: vi.fn(),
  };
  const releaseModel = {
    create: vi.fn(),
    find: vi.fn(),
    exists: vi.fn(),
  };
  const appService = { assertPublishedRelease: vi.fn() };
  let service: WorkflowService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorkflowService(
      model as any,
      releaseModel as any,
      appService as any,
    );
  });

  it('creates a workflow owned by the authenticated user', async () => {
    model.create.mockResolvedValue({ id: 'workflow-1' });

    await service.create(ownerId, {
      document: { nodes: [], edges: [], settings: {} },
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        ownerId: expect.any(Types.ObjectId),
      }),
    );
  });

  it('lists only workflows owned by the authenticated user', async () => {
    const lean = vi.fn().mockResolvedValue([]);
    const populate = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ populate });
    model.find.mockReturnValue({ sort });

    await service.findAll(ownerId);

    expect(model.find).toHaveBeenCalledWith({
      isDelete: false,
      ownerId: expect.any(Types.ObjectId),
    });
    expect(sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(populate).toHaveBeenCalledWith({
      path: 'ownerId',
      select: 'name email emailVerified image createdAt updatedAt',
    });
  });

  it('returns a workflow only when it belongs to the authenticated user', async () => {
    const lean = vi.fn().mockResolvedValue({ id: 'workflow-1' });
    model.findOne.mockReturnValue({
      populate: vi.fn().mockReturnValue({ lean }),
    });

    await expect(service.findOne(ownerId, 'workflow-1')).resolves.toEqual({
      id: 'workflow-1',
    });
    expect(model.findOne).toHaveBeenCalledWith({
      isDelete: false,
      id: 'workflow-1',
      ownerId: expect.any(Types.ObjectId),
    });
  });

  it('rejects missing, updated, or deleted workflows', async () => {
    model.findOne.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });
    model.findOneAndUpdate.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
      lean: vi.fn().mockResolvedValue(null),
    });
    await expect(service.findOne(ownerId, 'workflow-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.update(ownerId, 'workflow-1', {
        document: { nodes: [], edges: [], settings: {} },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ownerId, 'workflow-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft deletes a workflow', async () => {
    const lean = vi.fn().mockResolvedValue({ id: 'workflow-1' });
    model.findOneAndUpdate.mockReturnValue({ lean });

    await service.remove(ownerId, 'workflow-1');

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        isDelete: false,
        id: 'workflow-1',
        ownerId: expect.any(Types.ObjectId),
      },
      { deletedAt: expect.any(Date), isDelete: true },
      { new: true },
    );
  });

  it('publishes an immutable snapshot of the current draft', async () => {
    const draft = {
      _id: 'mongo-workflow-1',
      id: 'workflow-1',
      document: { nodes: [{ id: 'start' }], edges: [], settings: {} },
    };
    model.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(draft) });
    releaseModel.create.mockResolvedValue({
      _id: 'mongo-release-1',
      id: 'release-1',
      version: '1.0.0',
    });
    model.updateOne.mockResolvedValue({});

    await service.publish(ownerId, 'workflow-1', {
      version: '1.0.0',
      releaseNote: 'Initial release',
    });

    expect(releaseModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'workflow-1',
        version: '1.0.0',
        releaseNote: 'Initial release',
        document: draft.document,
        publishedAt: expect.any(Date),
      }),
    );
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'mongo-workflow-1' },
      { latestReleaseId: 'mongo-release-1', status: 'published' },
    );
  });

  it('rejects a Team App reference whose immutable archive no longer matches', async () => {
    const document = {
      nodes: [
        {
          id: 'process',
          data: {
            appRef: {
              source: 'team',
              remoteAppId: 'app-1',
              releaseId: 'release-1',
              archiveSha256: 'a'.repeat(64),
            },
          },
        },
      ],
      edges: [],
      settings: {},
    };
    model.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'mongo-workflow-1',
        id: 'workflow-1',
        document,
      }),
    });
    appService.assertPublishedRelease.mockRejectedValue(
      new BadRequestException('archive changed'),
    );

    await expect(
      service.publish(ownerId, 'workflow-1', {
        version: '1.0.0',
        releaseNote: 'Initial release',
      }),
    ).rejects.toThrow('archive changed');
    expect(releaseModel.create).not.toHaveBeenCalled();
  });

  it('rejects a release whose edges reference missing nodes', async () => {
    model.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'mongo-workflow-1',
        id: 'workflow-1',
        document: {
          nodes: [{ id: 'start' }],
          edges: [{ source: 'start', target: 'missing' }],
          settings: {},
        },
      }),
    });

    await expect(
      service.publish(ownerId, 'workflow-1', {
        version: '1.0.0',
        releaseNote: 'Initial release',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(releaseModel.create).not.toHaveBeenCalled();
  });
});
