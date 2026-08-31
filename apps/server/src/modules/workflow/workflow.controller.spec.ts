import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

describe('WorkflowController', () => {
  const workflowService = {
    create: vi.fn(),
    findAll: vi.fn(),
    findOne: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
  const session = { user: { id: 'user-1' } } as any;
  let controller: WorkflowController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new WorkflowController(
      workflowService as unknown as WorkflowService,
    );
  });

  it('passes the authenticated user and document when creating a workflow', () => {
    const dto = { document: { nodes: [], edges: [], settings: {} } };
    controller.create(session, dto);

    expect(workflowService.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('scopes reads to the authenticated user', () => {
    controller.findAll(session);
    controller.findOne(session, 'workflow-1');

    expect(workflowService.findAll).toHaveBeenCalledWith('user-1');
    expect(workflowService.findOne).toHaveBeenCalledWith(
      'user-1',
      'workflow-1',
    );
  });

  it('passes updates and deletes to the service with the workflow id', () => {
    const dto = { document: { nodes: [], edges: [], settings: {} } };
    controller.update(session, 'workflow-1', dto);
    controller.remove(session, 'workflow-1');

    expect(workflowService.update).toHaveBeenCalledWith(
      'user-1',
      'workflow-1',
      dto,
    );
    expect(workflowService.remove).toHaveBeenCalledWith('user-1', 'workflow-1');
  });
});
