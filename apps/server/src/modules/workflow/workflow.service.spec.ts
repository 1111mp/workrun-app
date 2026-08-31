import { NotFoundException } from '@nestjs/common';
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
  };
  let service: WorkflowService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorkflowService(model as any);
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
});
