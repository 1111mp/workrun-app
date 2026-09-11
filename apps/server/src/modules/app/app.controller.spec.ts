import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  const appService = {
    create: vi.fn(),
    createVersion: vi.fn(),
    hasVersion: vi.fn(),
    uploadSourceArchive: vi.fn(),
    findAll: vi.fn(),
    findOne: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
  const session = { user: { id: 'user-1' } } as any;
  let controller: AppController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AppController(appService as unknown as AppService);
  });

  it('passes the authenticated user and body when creating an app', () => {
    const dto = { name: 'Process data', kind: 'tool' as const };
    controller.create(session, dto);

    expect(appService.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('passes version publication requests to the service', () => {
    const dto = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      version: '1.2.3',
      releaseNote: 'Initial release',
    };
    const resourceDto = {
      format: 'tar.gz' as const,
      sha256: 'a'.repeat(64),
    };
    const archive = { buffer: Buffer.from('archive') } as Express.Multer.File;

    controller.createVersion(session, 'app-1', dto);
    controller.uploadSourceArchive(
      session,
      'app-1',
      'version-1',
      resourceDto,
      archive,
    );

    expect(appService.createVersion).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      dto,
    );
    expect(appService.uploadSourceArchive).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      'version-1',
      resourceDto,
      archive,
    );
  });

  it('checks a version against the authenticated app owner', () => {
    controller.hasVersion(session, 'app-1', '1.2.3');

    expect(appService.hasVersion).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      '1.2.3',
    );
  });

  it('scopes reads to the authenticated user', () => {
    const query = {
      pageSize: 20,
      cursor: 'app-1',
    };
    controller.findAll(session, query);
    controller.findOne(session, 'app-1');

    expect(appService.findAll).toHaveBeenCalledWith('user-1', query);
    expect(appService.findOne).toHaveBeenCalledWith('user-1', 'app-1');
  });

  it('passes updates and deletes to the service with the app id', () => {
    const dto = { name: 'Renamed app' };
    controller.update(session, 'app-1', dto);
    controller.remove(session, 'app-1');

    expect(appService.update).toHaveBeenCalledWith('user-1', 'app-1', dto);
    expect(appService.remove).toHaveBeenCalledWith('user-1', 'app-1');
  });
});
