import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

import { AppService } from './app.service';

describe('AppService', () => {
  const ownerId = '507f191e810c19729de860ea';
  const model = {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  };
  let service: AppService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AppService(model as any);
  });

  it('creates an app owned by the authenticated user', async () => {
    model.create.mockResolvedValue({ id: 'app-1' });

    await service.create(ownerId, {
      name: 'Process data',
      projectRoot: '/Users/me/projects/process-data',
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: 'Process data',
        ownerId: expect.any(Types.ObjectId),
        projectRoot: '/Users/me/projects/process-data',
      }),
    );
  });

  it('lists only apps owned by the authenticated user', async () => {
    const lean = vi.fn().mockResolvedValue([]);
    const populate = vi.fn().mockReturnValue({ lean });
    const limit = vi.fn().mockReturnValue({ populate });
    const sort = vi.fn().mockReturnValue({ limit });
    model.find.mockReturnValue({ sort });

    await service.findAll(ownerId);

    expect(model.find).toHaveBeenCalledWith({
      isDelete: false,
      ownerId: expect.any(Types.ObjectId),
    });
    expect(sort).toHaveBeenCalledWith({ updatedAt: -1, id: -1 });
    expect(limit).toHaveBeenCalledWith(31);
    expect(populate).toHaveBeenCalledWith({
      path: 'ownerId',
      select: 'name email emailVerified image createdAt updatedAt',
    });
  });

  it('uses an exclusive cursor and exposes the last returned app as nextCursor', async () => {
    const updatedAt = new Date('2026-09-08T00:00:00.000Z');
    const items = [
      { id: 'app-3', updatedAt },
      { id: 'app-2', updatedAt },
      { id: 'app-1', updatedAt },
    ];
    const lean = vi.fn().mockResolvedValue(items);
    const populate = vi.fn().mockReturnValue({ lean });
    const limit = vi.fn().mockReturnValue({ populate });
    const sort = vi.fn().mockReturnValue({ limit });
    model.find.mockReturnValue({ sort });
    const cursorLean = vi.fn().mockResolvedValue({
      id: 'app-4',
      updatedAt,
    });
    const select = vi.fn().mockReturnValue({ lean: cursorLean });
    model.findOne.mockReturnValue({ select });

    await expect(
      service.findAll(ownerId, {
        pageSize: 2,
        cursor: 'app-4',
      }),
    ).resolves.toEqual({
      items: items.slice(0, 2),
      nextCursor: 'app-2',
    });
    expect(model.findOne).toHaveBeenCalledWith({
      id: 'app-4',
      ownerId: expect.any(Types.ObjectId),
    });
    expect(select).toHaveBeenCalledWith('id updatedAt');
    expect(model.find).toHaveBeenCalledWith({
      isDelete: false,
      ownerId: expect.any(Types.ObjectId),
      $or: [
        { updatedAt: { $lt: updatedAt } },
        { id: { $lt: 'app-4' }, updatedAt },
      ],
    });
    expect(limit).toHaveBeenCalledWith(3);
  });

  it('returns an app only when it belongs to the authenticated user', async () => {
    const lean = vi.fn().mockResolvedValue({ id: 'app-1' });
    model.findOne.mockReturnValue({
      populate: vi.fn().mockReturnValue({ lean }),
    });

    await expect(service.findOne(ownerId, 'app-1')).resolves.toEqual({
      id: 'app-1',
    });
    expect(model.findOne).toHaveBeenCalledWith({
      isDelete: false,
      id: 'app-1',
      ownerId: expect.any(Types.ObjectId),
    });
  });

  it('rejects missing, updated, or deleted apps', async () => {
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
    await expect(service.findOne(ownerId, 'app-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.update(ownerId, 'app-1', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(ownerId, 'app-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft deletes an app', async () => {
    const lean = vi.fn().mockResolvedValue({ id: 'app-1' });
    model.findOneAndUpdate.mockReturnValue({ lean });

    await service.remove(ownerId, 'app-1');

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        isDelete: false,
        id: 'app-1',
        ownerId: expect.any(Types.ObjectId),
      },
      { deletedAt: expect.any(Date), isDelete: true },
      { new: true },
    );
  });
});
