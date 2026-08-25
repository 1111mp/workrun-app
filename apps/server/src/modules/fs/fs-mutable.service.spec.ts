import { Readable } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { MutableFSService } from './fs-mutable.service';

const metadata = {
  id: 'file-id',
  scope: 'project-a',
  filename: 'settings.json',
  contentType: 'application/json',
  size: 7,
  extra: { mimetype: 'application/json' },
};

function createDocument(content = '{"a":1}') {
  return {
    content,
    toObject: vi.fn().mockReturnValue({ metadata }),
  };
}

describe('MutableFSService', () => {
  it('upserts text content using its logical path', async () => {
    const document = createDocument();
    const model = {
      findOneAndUpdate: vi.fn().mockResolvedValue(document),
    };
    const service = new MutableFSService(model as never, 'mutable');

    await expect(
      service.write('project-a', 'settings.json', Readable.from(['{"a":1}']), {
        mimetype: 'application/json',
      }),
    ).resolves.toEqual(metadata);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      {
        bucketName: 'mutable',
        scope: 'project-a',
        filename: 'settings.json',
      },
      {
        $set: {
          content: '{"a":1}',
          contentType: 'application/json',
          extra: { mimetype: 'application/json' },
          size: 7,
        },
        $setOnInsert: {
          bucketName: 'mutable',
          scope: 'project-a',
          filename: 'settings.json',
        },
      },
      { new: true, upsert: true },
    );
  });

  it('returns a readable stream for a stored document', async () => {
    const model = {
      findOne: vi.fn().mockResolvedValue(createDocument('hello')),
    };
    const service = new MutableFSService(model as never, 'mutable');

    const stream = (await service.read('file-id')) as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('rejects deletion of a file outside the requested scope', async () => {
    const model = {
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
    const service = new MutableFSService(model as never, 'mutable');

    await expect(service.remove('project-a', 'file-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(model.deleteOne).toHaveBeenCalledWith({
      _id: 'file-id',
      bucketName: 'mutable',
      scope: 'project-a',
    });
  });
});
