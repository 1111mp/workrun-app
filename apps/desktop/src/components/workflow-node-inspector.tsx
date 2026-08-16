import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
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
  useComboboxAnchor,
} from '@workspace/ui/components';
import type { Node } from '@xyflow/react';
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react';

import { listProcessNodes } from '@/services/process-node';
import { listTools } from '@/services/tool';

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

function getNumber(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

function optionalNumber(value: string) {
  if (value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function getStringArray(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
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

  return cases.flatMap((switchCase) => {
    if (typeof switchCase !== 'object' || switchCase === null) {
      return [];
    }

    const record = switchCase as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.label !== 'string') {
      return [];
    }

    return [
      {
        id: record.id,
        label: record.label,
        condition: typeof record.condition === 'string' ? record.condition : '',
      },
    ];
  });
}

function getSwitchDefault(
  data: Record<string, unknown>,
): WorkflowSwitchDefault {
  const value = data.defaultCase;
  if (typeof value !== 'object' || value === null) {
    return { label: getText(data, 'defaultLabel') || 'Default', condition: '' };
  }

  const record = value as Record<string, unknown>;
  return {
    label: typeof record.label === 'string' ? record.label : 'Default',
    condition: typeof record.condition === 'string' ? record.condition : '',
  };
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
  const tools = useQuery({
    queryKey: ['tools'],
    queryFn: listTools,
    enabled: node?.type === 'agent',
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
            <FieldGroup className='grid grid-cols-2 gap-3'>
              <Field>
                <Label htmlFor='agent-temperature'>Temperature</Label>
                <FieldDescription>
                  Controls variation (0–2). Leave empty for the model default.
                </FieldDescription>
                <Input
                  id='agent-temperature'
                  type='number'
                  min='0'
                  max='2'
                  step='0.1'
                  value={getNumber(data, 'temperature')}
                  onChange={(event) =>
                    updateData({
                      temperature: optionalNumber(event.target.value),
                    })
                  }
                />
              </Field>
              <Field>
                <Label htmlFor='agent-top-p'>Top P</Label>
                <FieldDescription>
                  Controls token diversity (0–1). Leave empty for the model
                  default.
                </FieldDescription>
                <Input
                  id='agent-top-p'
                  type='number'
                  min='0'
                  max='1'
                  step='0.05'
                  value={getNumber(data, 'topP')}
                  onChange={(event) =>
                    updateData({ topP: optionalNumber(event.target.value) })
                  }
                />
              </Field>
            </FieldGroup>
            <Field>
              <Label>Tools</Label>
              <FieldDescription>
                Select local Tool Apps or tools discovered from running MCP
                servers.
              </FieldDescription>
              <ToolCombobox
                tools={tools.data ?? []}
                selectedIds={getStringArray(data, 'toolIds')}
                isLoading={tools.isLoading}
                onChange={(toolIds) => updateData({ toolIds })}
              />
            </Field>
            <FieldGroup className='grid grid-cols-2 gap-3'>
              <Field>
                <Label htmlFor='agent-max-tool-calls'>Call limit</Label>
                <FieldDescription>
                  Maximum Tool App calls in one Agent run.
                </FieldDescription>
                <Input
                  id='agent-max-tool-calls'
                  type='number'
                  min='1'
                  max='50'
                  step='1'
                  value={getNumber(data, 'maxToolCalls') || 8}
                  onChange={(event) =>
                    updateData({
                      maxToolCalls: optionalNumber(event.target.value),
                    })
                  }
                />
              </Field>
              <Field>
                <Label htmlFor='agent-tool-timeout'>Tool timeout</Label>
                <FieldDescription>
                  Seconds allowed for each Tool App call.
                </FieldDescription>
                <Input
                  id='agent-tool-timeout'
                  type='number'
                  min='1'
                  max='600'
                  step='1'
                  value={getNumber(data, 'toolTimeoutSeconds') || 60}
                  onChange={(event) =>
                    updateData({
                      toolTimeoutSeconds: optionalNumber(event.target.value),
                    })
                  }
                />
              </Field>
            </FieldGroup>
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
          (processNode) =>
            processNode.definition.kind === 'workflow' &&
            processNode.definition.id === selectedId,
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
                      processNode.definition.kind === 'workflow' &&
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
                        processNode.installStatus === 'installed' &&
                        processNode.definition.kind === 'workflow',
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
        const defaultCase = getSwitchDefault(data);

        return (
          <FieldGroup>
            <TextField
              id='switch-label'
              label='Name'
              description='A short name shown on the workflow canvas.'
              value={getText(data, 'label')}
              onChange={(label) => updateData({ label })}
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
                          label: `Case ${cases.length + 1}`,
                          condition: '',
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
                Cases are evaluated from top to bottom. The first matching
                condition determines the outgoing branch.
              </FieldDescription>
              <FieldGroup className='gap-3'>
                {cases.map((switchCase, index) => (
                  <Field key={switchCase.id}>
                    <div className='flex items-center justify-between gap-2'>
                      <Label>Case {index + 1}</Label>
                      <Button
                        type='button'
                        size='icon-sm'
                        variant='destructive'
                        aria-label={`Remove case ${index + 1}`}
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
                    <TextField
                      id={`switch-case-${switchCase.id}-label`}
                      label='Label'
                      value={switchCase.label}
                      placeholder={`Case ${index + 1}`}
                      onChange={(label) =>
                        updateData({
                          cases: cases.map((item) =>
                            item.id === switchCase.id
                              ? { ...item, label }
                              : item,
                          ),
                        })
                      }
                    />
                    <TextareaField
                      id={`switch-case-${switchCase.id}-condition`}
                      label='Condition'
                      value={switchCase.condition}
                      placeholder={`When condition ${index + 1} is met`}
                      onChange={(condition) =>
                        updateData({
                          cases: cases.map((item) =>
                            item.id === switchCase.id
                              ? { ...item, condition }
                              : item,
                          ),
                        })
                      }
                    />
                  </Field>
                ))}
              </FieldGroup>
            </Field>
            <Field>
              <Label>Default</Label>
              <FieldDescription>
                Used when no case condition matches.
              </FieldDescription>
              <TextField
                disabled
                id='switch-default-label'
                label='Label'
                value={defaultCase.label}
                placeholder='Default'
                onChange={() => undefined}
              />
              <TextareaField
                disabled
                id='switch-default-condition'
                label='Condition'
                value={defaultCase.condition}
                placeholder='Other cases'
                onChange={() => undefined}
              />
            </Field>
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

function ToolCombobox({
  tools,
  selectedIds,
  isLoading = false,
  onChange,
}: {
  tools: Awaited<ReturnType<typeof listTools>>;
  selectedIds: string[];
  isLoading?: boolean;
  onChange: (toolIds: string[]) => void;
}) {
  const anchor = useComboboxAnchor();
  const selectedTools = tools.filter((tool) => selectedIds.includes(tool.id));
  const toolApps = tools.filter((tool) => tool.source === 'process');
  const mcpToolGroups = new Map<string, typeof tools>();
  for (const tool of tools.filter((tool) => tool.source === 'mcp')) {
    const key = tool.sourceId ?? tool.sourceName ?? 'unknown-server';
    const group = mcpToolGroups.get(key) ?? [];
    group.push(tool);
    mcpToolGroups.set(key, group);
  }

  return (
    <Combobox
      items={tools}
      multiple
      value={selectedTools}
      disabled={isLoading}
      onValueChange={(selected) => onChange(selected.map((tool) => tool.id))}
      itemToStringValue={(tool) => `${tool.displayName} ${tool.description}`}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {selectedTools.map((tool) => (
            <ComboboxChip key={tool.id}>{tool.displayName}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          disabled={isLoading}
          placeholder={isLoading ? 'Loading tools…' : 'Search tools…'}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>
          No tools found. Start an MCP server to discover its tools.
        </ComboboxEmpty>
        <ComboboxList>
          {toolApps.length ? (
            <ComboboxGroup>
              <ComboboxLabel>Tool Apps</ComboboxLabel>
              {toolApps.map((tool) => (
                <ToolComboboxItem key={tool.id} tool={tool} />
              ))}
            </ComboboxGroup>
          ) : null}
          {Array.from(mcpToolGroups.entries()).map(
            ([serverId, serverTools]) => (
              <ComboboxGroup key={serverId}>
                <ComboboxLabel>
                  MCP · {serverTools[0]?.sourceName ?? 'Server'}
                </ComboboxLabel>
                {serverTools.map((tool) => (
                  <ToolComboboxItem key={tool.id} tool={tool} />
                ))}
              </ComboboxGroup>
            ),
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ToolComboboxItem({
  tool,
}: {
  tool: Awaited<ReturnType<typeof listTools>>[number];
}) {
  return (
    <ComboboxItem value={tool}>
      <span className='flex min-w-0 flex-col'>
        <span className='truncate'>{tool.displayName}</span>
        <span className='text-muted-foreground truncate text-xs'>
          {tool.description}
        </span>
      </span>
    </ComboboxItem>
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
  disabled = false,
}: {
  id: string;
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      {description && <FieldDescription>{description}</FieldDescription>}
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={className}
      />
    </Field>
  );
}

export { WorkflowNodeInspector };
