import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  const appService = {
    create: vi.fn(),
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

  it('scopes reads to the authenticated user', () => {
    controller.findAll(session);
    controller.findOne(session, 'app-1');

    expect(appService.findAll).toHaveBeenCalledWith('user-1');
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
