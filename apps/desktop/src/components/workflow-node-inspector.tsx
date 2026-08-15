import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Field,
  FieldDescription,
  FieldGroup,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@workspace/ui/components';
import type { Node } from '@xyflow/react';
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react';

import { listProcessNodes } from '@/services/process-node';

type WorkflowNodeInspectorProps = {
  node: Node | null;
  onClose: () => void;
  onDataChange: (nodeId: string, patch: Record<string, unknown>) => void;
  modelProfiles?: ModelDefinition[];
};

const nodeTitles: Record<string, string> = {
  agent: 'Agent',
  remote_agent: 'Remote Agent',
  process: 'App',
  if_else: 'If / Else',
  switch: 'Switch',
  group: 'Group',
  start: 'Start',
  end: 'End',
};

const modelProviderLabels: Record<ModelDefinition['provider'], string> = {
  gemini: 'Gemini',
  open_ai: 'OpenAI',
  open_ai_strict: 'OpenAI Strict',
  anthropic: 'Anthropic',
  deep_seek: 'DeepSeek',
  groq: 'Groq',
  ollama: 'Ollama',
};

function groupModelProfiles(modelProfiles: ModelDefinition[]) {
  return modelProfiles.reduce<
    Partial<Record<ModelDefinition['provider'], ModelDefinition[]>>
  >((groups, profile) => {
    (groups[profile.provider] ??= []).push(profile);
    return groups;
  }, {});
}

function getText(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function getRouteField(data: Record<string, unknown>) {
  const selector = data.selector;
  if (typeof selector !== 'object' || selector === null) {
    return '';
  }

  const field = (selector as Record<string, unknown>).field;
  return typeof field === 'string' ? field : '';
}

function getIfElseBranch(
  data: Record<string, unknown>,
  branch: 'true' | 'false',
): WorkflowIfElseBranch {
  const conditions = data.conditions;
  if (typeof conditions !== 'object' || conditions === null) {
    return { label: branch === 'true' ? 'True' : 'False', condition: '' };
  }

  const value = (conditions as Record<string, unknown>)[branch];
  if (typeof value !== 'object' || value === null) {
    return { label: branch === 'true' ? 'True' : 'False', condition: '' };
  }

  const record = value as Record<string, unknown>;
  return {
    label:
      typeof record.label === 'string'
        ? record.label
        : branch === 'true'
          ? 'True'
          : 'False',
    condition: typeof record.condition === 'string' ? record.condition : '',
  };
}

function getSwitchCases(data: Record<string, unknown>): WorkflowSwitchCase[] {
  const cases = data.cases;
  if (!Array.isArray(cases)) {
    return [];
  }

  return cases.filter(
    (switchCase): switchCase is WorkflowSwitchCase =>
      typeof switchCase === 'object' &&
      switchCase !== null &&
      typeof switchCase.id === 'string' &&
      typeof switchCase.value === 'string' &&
      typeof switchCase.label === 'string',
  );
}

function WorkflowNodeInspector({
  node,
  onClose,
  onDataChange,
  modelProfiles = [],
}: WorkflowNodeInspectorProps) {
  const data = node?.data ?? {};
  const title = node ? (nodeTitles[node.type ?? ''] ?? 'Node') : 'Node';
  const profilesByProvider = groupModelProfiles(modelProfiles);
  const processNodes = useQuery({
    queryKey: ['processNodes'],
    queryFn: listProcessNodes,
    enabled: node?.type === 'process',
  });

  const updateData = (patch: Record<string, unknown>) => {
    if (node) {
      onDataChange(node.id, patch);
    }
  };

  const renderFields = () => {
    if (!node) {
      return null;
    }

    switch (node.type) {
      case 'agent':
        return (
          <FieldGroup>
            <TextField
              id='agent-name'
              label='Name'
              description='A short name shown on the workflow canvas.'
              value={getText(data, 'name')}
              onChange={(name) => updateData({ name })}
            />
            <Field>
              <Label htmlFor='agent-model-profile'>Model profile</Label>
              <FieldDescription>
                Selects the provider, model, and encrypted credential used by
                this agent.
              </FieldDescription>
              <Select
                value={getText(data, 'modelProfileId')}
                onValueChange={(modelProfileId) =>
                  updateData({ modelProfileId })
                }
              >
                <SelectTrigger id='agent-model-profile' className='w-full'>
                  <SelectValue placeholder='Select a model profile' />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(profilesByProvider).map(
                    ([provider, profiles]) => (
                      <SelectGroup key={provider}>
                        <SelectLabel>
                          {
                            modelProviderLabels[
                              provider as ModelDefinition['provider']
                            ]
                          }
                        </SelectLabel>
                        {profiles?.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.name} · {profile.model}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ),
                  )}
                </SelectContent>
              </Select>
            </Field>
            <TextareaField
              id='agent-description'
              label='Description'
              description='Briefly describe this agent’s responsibility for people reading the workflow.'
              value={getText(data, 'description')}
              onChange={(description) => updateData({ description })}
            />
            <TextareaField
              id='agent-instruction'
              label='Instruction'
              description='Give the agent its role, goals, constraints, and the expected output.'
              value={getText(data, 'instruction')}
              onChange={(instruction) => updateData({ instruction })}
              className='min-h-36 font-mono text-xs'
            />
          </FieldGroup>
        );
      case 'remote_agent':
        return (
          <FieldGroup>
            <TextField
              id='remote-agent-name'
              label='Name'
              description='A short name shown on the workflow canvas.'
              value={getText(data, 'name')}
              onChange={(name) => updateData({ name })}
            />
            <TextField
              id='remote-agent-url'
              label='Service URL'
              description='The HTTPS endpoint used to invoke the remote agent service.'
              type='url'
              value={getText(data, 'url')}
              onChange={(url) => updateData({ url })}
            />
            <TextareaField
              id='remote-agent-description'
              label='Description'
              description='Explain what the remote service does and when this workflow should call it.'
              value={getText(data, 'description')}
              onChange={(description) => updateData({ description })}
            />
          </FieldGroup>
        );
      case 'process': {
        const selectedId = getText(data, 'processNodeId');
        const selectedApp = processNodes.data?.find(
          (processNode) => processNode.definition.id === selectedId,
        );
        return (
          <FieldGroup>
            <TextField
              id='process-name'
              label='Name'
              description='A short name shown on the workflow canvas.'
              value={getText(data, 'name')}
              onChange={(name) => updateData({ name })}
            />
            <Field>
              <Label htmlFor='process-node'>App</Label>
              <FieldDescription>
                The selected local app receives the complete workflow state as
                JSON on stdin and returns its result with{' '}
                <code>process.result()</code>.
              </FieldDescription>
              <Select
                value={selectedId}
                onValueChange={(processNodeId) => {
                  const app = processNodes.data?.find(
                    (processNode) =>
                      processNode.definition.id === processNodeId,
                  );
                  updateData({
                    processNodeId,
                    ...(app && {
                      // name: app.definition.name,
                      description: app.definition.description,
                    }),
                  });
                }}
              >
                <SelectTrigger id='process-node' className='w-full'>
                  <span className='flex flex-1 truncate text-left'>
                    {selectedApp?.definition.name ??
                      (processNodes.isLoading
                        ? 'Loading apps…'
                        : 'Select an installed app')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {processNodes.data
                    ?.filter(
                      (processNode) =>
                        processNode.installStatus === 'installed',
                    )
                    .map((processNode) => (
                      <SelectItem
                        key={processNode.definition.id}
                        value={processNode.definition.id}
                      >
                        {processNode.definition.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {selectedId && !selectedApp ? (
                <FieldDescription className='text-destructive'>
                  The selected app is unavailable. Choose another installed app.
                </FieldDescription>
              ) : null}
            </Field>
            <TextareaField
              id='process-description'
              label='Description'
              description='Explain what this app does in the workflow.'
              value={getText(data, 'description')}
              onChange={(description) => updateData({ description })}
            />
          </FieldGroup>
        );
      }
      case 'if_else':
        return (
          <FieldGroup>
            <TextField
              id='if-else-label'
              label='Name'
              description='A short name shown on the workflow canvas.'
              value={getText(data, 'label')}
              onChange={(label) => updateData({ label })}
            />
            {(['true', 'false'] as const).map((branch) => {
              const current = getIfElseBranch(data, branch);
              const other = getIfElseBranch(
                data,
                branch === 'true' ? 'false' : 'true',
              );
              const isTrueBranch = branch === 'true';

              return (
                <FieldGroup key={branch}>
                  <TextField
                    id={`if-else-${branch}-label`}
                    label={`${isTrueBranch ? 'True' : 'False'} label`}
                    value={current.label}
                    onChange={(label) =>
                      updateData({
                        conditions: {
                          [branch]: { ...current, label },
                          [isTrueBranch ? 'false' : 'true']: other,
                        },
                      })
                    }
                  />
                  <TextareaField
                    id={`if-else-${branch}-condition`}
                    label={`${isTrueBranch ? 'True' : 'False'} condition`}
                    placeholder={
                      isTrueBranch
                        ? 'When condition is true'
                        : 'When condition is false'
                    }
                    description='For example: score >= 80 or approved == true.'
                    value={current.condition}
                    onChange={(condition) =>
                      updateData({
                        conditions: {
                          [branch]: { ...current, condition },
                          [isTrueBranch ? 'false' : 'true']: other,
                        },
                      })
                    }
                  />
                </FieldGroup>
              );
            })}
          </FieldGroup>
        );
      case 'switch': {
        const cases = getSwitchCases(data);

        return (
          <FieldGroup>
            <TextField
              id='switch-label'
              label='Name'
              description='A short name shown on the workflow canvas.'
              value={getText(data, 'label')}
              onChange={(label) => updateData({ label })}
            />
            <TextField
              id='switch-state-field'
              label='Route state field'
              description='The state field whose value is matched against the route values below.'
              value={getRouteField(data)}
              onChange={(field) => updateData({ selector: { field } })}
            />
            <Field>
              <div className='flex items-center justify-between gap-2'>
                <Label>Cases</Label>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() =>
                    updateData({
                      cases: [
                        ...cases,
                        {
                          id: crypto.randomUUID(),
                          value: `case_${cases.length + 1}`,
                          label: `Case ${cases.length + 1}`,
                        },
                      ],
                    })
                  }
                >
                  <PlusIcon aria-hidden='true' />
                  Add case
                </Button>
              </div>
              <FieldDescription>
                Each route value is matched exactly. The display label only
                names the branch on the canvas and does not affect routing.
              </FieldDescription>
              <div className='space-y-2'>
                {cases.map((switchCase, index) => (
                  <div key={switchCase.id} className='flex items-center gap-2'>
                    <div className='min-w-0 flex-1 space-y-1'>
                      <Label
                        className='text-xs'
                        htmlFor={`switch-case-${switchCase.id}-value`}
                      >
                        Route value
                      </Label>
                      <Input
                        id={`switch-case-${switchCase.id}-value`}
                        aria-label={`Case ${index + 1} route value`}
                        placeholder='e.g. approved'
                        value={switchCase.value}
                        onChange={(event) =>
                          updateData({
                            cases: cases.map((item) =>
                              item.id === switchCase.id
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                    <div className='min-w-0 flex-1 space-y-1'>
                      <Label
                        className='text-xs'
                        htmlFor={`switch-case-${switchCase.id}-label`}
                      >
                        Display label
                      </Label>
                      <Input
                        id={`switch-case-${switchCase.id}-label`}
                        aria-label={`Case ${index + 1} label`}
                        placeholder='e.g. Approved'
                        value={switchCase.label}
                        onChange={(event) =>
                          updateData({
                            cases: cases.map((item) =>
                              item.id === switchCase.id
                                ? { ...item, label: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                    <Button
                      type='button'
                      size='icon-sm'
                      variant='destructive'
                      className='mb-1 self-end'
                      aria-label={`Remove ${switchCase.label}`}
                      onClick={() =>
                        updateData({
                          cases: cases.filter(
                            (item) => item.id !== switchCase.id,
                          ),
                        })
                      }
                    >
                      <Trash2Icon aria-hidden='true' />
                    </Button>
                  </div>
                ))}
              </div>
            </Field>
            <TextField
              id='switch-default-label'
              label='Default branch label'
              description='The name shown for the fallback branch used when no case matches.'
              value={getText(data, 'defaultLabel')}
              onChange={(defaultLabel) => updateData({ defaultLabel })}
            />
          </FieldGroup>
        );
      }
      case 'start':
      case 'end':
      case 'group':
        return (
          <FieldGroup>
            <TextField
              id={`${node.type}-label`}
              label='Name'
              description={
                node.type === 'group'
                  ? 'A title for this layout container. Resize it directly on the canvas.'
                  : `A short name shown on the workflow canvas for this ${node.type} node.`
              }
              disabled={node.type === 'start' || node.type === 'end'}
              value={getText(data, 'label')}
              onChange={(label) => updateData({ label })}
            />
          </FieldGroup>
        );
      default:
        return null;
    }
  };

  return (
    <Drawer
      open={node !== null}
      modal={false}
      swipeDirection='right'
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Edit {title}</DrawerTitle>
          <DrawerDescription>
            Changes are applied to the workflow.
          </DrawerDescription>
        </DrawerHeader>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          className='absolute top-3 right-3'
          aria-label='Close node editor'
          onClick={onClose}
        >
          <XIcon aria-hidden='true' />
        </Button>
        <div className='min-h-0 overflow-y-auto px-4 py-4'>
          {renderFields()}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function TextField({
  id,
  label,
  description,
  value,
  type = 'text',
  placeholder,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  value: string;
  type?: 'text' | 'url';
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      {description && <FieldDescription>{description}</FieldDescription>}
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function TextareaField({
  id,
  label,
  description,
  value,
  onChange,
  className,
  placeholder,
}: {
  id: string;
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}) {
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      {description && <FieldDescription>{description}</FieldDescription>}
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={className}
      />
    </Field>
  );
}

export { WorkflowNodeInspector };
