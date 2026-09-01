import { useQuery } from '@tanstack/react-query';
import {
  Badge,
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
  FieldLegend,
  FieldSet,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useComboboxAnchor,
} from '@workspace/ui/components';
import type { Node } from '@xyflow/react';
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { type ReactNode } from 'react';

import { listProcessNodes } from '@/services/process-node';
import { listSkills, type SkillSummary } from '@/services/skill';
import { listTools, type ToolDefinition } from '@/services/tool';
import { listWorkflows } from '@/services/workflow';

type WorkflowNodeInspectorProps = {
  node: Node | null;
  workflowId?: string;
  executableNodes: Node[];
  onClose: () => void;
  onDataChange: (nodeId: string, patch: Record<string, unknown>) => void;
  modelProfiles?: ModelDefinition[];
};

const nodeTitles: Record<string, string> = {
  agent: 'Agent',
  codeact_agent: 'CodeAct Agent',
  remote_agent: 'Remote Agent',
  process: 'App',
  subworkflow: 'Subworkflow',
  if_else: 'If / Else',
  switch: 'Switch',
  human_review: 'Human Review',
  ask_user_question: 'Ask User Question',
  group: 'Group',
  start: 'Start',
  end: 'End',
  terminate: 'Terminate workflow',
};

const workflowOutputTypeLabels: Record<WorkflowInputType, string> = {
  string: 'Short text',
  textarea: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
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

function getNodeStateConfig(data: Record<string, unknown>) {
  const value = data.state;
  if (typeof value !== 'object' || value === null) {
    return { readers: [], globalKeys: [] };
  }
  const state = value as Record<string, unknown>;
  const access =
    typeof state.access === 'object' && state.access !== null
      ? (state.access as Record<string, unknown>)
      : {};
  return {
    readers: getStringArray(access, 'readers'),
    globalKeys: getStringArray(state, 'globalKeys'),
  };
}

function supportsNodeState(type: string | undefined) {
  return (
    type === 'agent' ||
    type === 'codeact_agent' ||
    type === 'remote_agent' ||
    type === 'process' ||
    type === 'subworkflow' ||
    type === 'if_else' ||
    type === 'switch' ||
    type === 'human_review' ||
    type === 'ask_user_question'
  );
}

function supportsGlobalPublication(type: string | undefined) {
  return (
    type === 'agent' ||
    type === 'codeact_agent' ||
    type === 'remote_agent' ||
    type === 'process' ||
    type === 'subworkflow'
  );
}

function getPersonalSkillNames(data: Record<string, unknown>) {
  const value = data.skillRefs;
  if (!Array.isArray(value)) return [];
  return value.flatMap((skill) => {
    if (typeof skill !== 'object' || skill === null) return [];
    const record = skill as Record<string, unknown>;
    return record.source === 'personal' && typeof record.name === 'string'
      ? [record.name]
      : [];
  });
}

function getBoolean(
  data: Record<string, unknown>,
  key: string,
  fallback: boolean,
) {
  const value = data[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getCodeActMounts(data: Record<string, unknown>) {
  const value = data.mounts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((mount) => {
    if (typeof mount !== 'object' || mount === null) return [];
    const record = mount as Record<string, unknown>;
    return [
      {
        virtualPath:
          typeof record.virtualPath === 'string' ? record.virtualPath : '',
        hostPath: typeof record.hostPath === 'string' ? record.hostPath : '',
        access: record.access === 'read_write' ? 'read_write' : 'read_only',
      } satisfies WorkflowCodeActMount,
    ];
  });
}

const mountAccessOptions = [
  { label: 'Read only', value: 'read_only' },
  { label: 'Read/write', value: 'read_write' },
];

function getCodeActEnvironment(data: Record<string, unknown>) {
  const value = data.environment;
  if (!Array.isArray(value)) return [];
  return value.flatMap((binding) => {
    if (typeof binding !== 'object' || binding === null) return [];
    const record = binding as Record<string, unknown>;
    return [
      {
        name: typeof record.name === 'string' ? record.name : '',
        value: typeof record.value === 'string' ? record.value : '',
      } satisfies WorkflowCodeActEnvironmentBinding,
    ];
  });
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

function getAskUserQuestionOptions(
  data: Record<string, unknown>,
): WorkflowAskUserQuestionOption[] {
  const options = data.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option !== 'object' || option === null) return [];
    const record = option as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.label !== 'string')
      return [];
    return [
      {
        id: record.id,
        label: record.label,
        ...(typeof record.description === 'string' && {
          description: record.description,
        }),
      },
    ];
  });
}

function CodeActRuntimeFields({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const mounts = getCodeActMounts(data);
  const environment = getCodeActEnvironment(data);

  const updateMount = (index: number, patch: Partial<WorkflowCodeActMount>) => {
    onChange({
      mounts: mounts.map((mount, candidate) =>
        candidate === index ? { ...mount, ...patch } : mount,
      ),
    });
  };
  const updateEnvironment = (
    index: number,
    patch: Partial<WorkflowCodeActEnvironmentBinding>,
  ) => {
    onChange({
      environment: environment.map((binding, candidate) =>
        candidate === index ? { ...binding, ...patch } : binding,
      ),
    });
  };

  return (
    <>
      <InspectorSection
        title='Script limits'
        description='Caps apply to each Python interpreter step, not the time spent calling tools.'
      >
        <FieldGroup className='grid grid-cols-2 gap-4'>
          <Field>
            <Label htmlFor='codeact-script-duration'>Step timeout</Label>
            <FieldDescription>
              Seconds allowed per script step (1–300).
            </FieldDescription>
            <Input
              id='codeact-script-duration'
              type='number'
              min='1'
              max='300'
              step='1'
              value={getNumber(data, 'maxScriptDurationSeconds') || 5}
              onChange={(event) =>
                onChange({
                  maxScriptDurationSeconds: optionalNumber(event.target.value),
                })
              }
            />
          </Field>
          <Field>
            <Label htmlFor='codeact-script-memory'>Memory limit</Label>
            <FieldDescription>
              MiB allowed for one script (16–4096).
            </FieldDescription>
            <Input
              id='codeact-script-memory'
              type='number'
              min='16'
              max='4096'
              step='16'
              value={getNumber(data, 'maxScriptMemoryMiB') || 256}
              onChange={(event) =>
                onChange({
                  maxScriptMemoryMiB: optionalNumber(event.target.value),
                })
              }
            />
          </Field>
        </FieldGroup>
      </InspectorSection>
      <InspectorSection
        title='Filesystem mounts'
        description='Mount only directories this agent needs. Paths outside these mounts are denied by Monty.'
      >
        <FieldGroup className='gap-3'>
          {mounts.map((mount, index) => (
            <Field key={`${mount.virtualPath}-${index}`}>
              <div className='flex items-end gap-2'>
                <Field className='min-w-0 flex-1'>
                  <Label htmlFor={`codeact-mount-virtual-${index}`}>
                    Virtual path
                  </Label>
                  <Input
                    id={`codeact-mount-virtual-${index}`}
                    value={mount.virtualPath}
                    placeholder='/data'
                    onChange={(event) =>
                      updateMount(index, { virtualPath: event.target.value })
                    }
                  />
                </Field>
                <Field className='min-w-0 flex-1'>
                  <Label htmlFor={`codeact-mount-host-${index}`}>
                    Host path
                  </Label>
                  <Input
                    id={`codeact-mount-host-${index}`}
                    value={mount.hostPath}
                    placeholder='/absolute/path'
                    onChange={(event) =>
                      updateMount(index, { hostPath: event.target.value })
                    }
                  />
                </Field>
                <Field className='w-28'>
                  <Label>Access</Label>
                  <Select
                    items={mountAccessOptions}
                    value={mount.access}
                    onValueChange={(access) =>
                      updateMount(index, {
                        access: access as WorkflowCodeActMount['access'],
                      })
                    }
                  >
                    <SelectTrigger aria-label={`Mount ${index + 1} access`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {mountAccessOptions.map(({ label, value }) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={`Remove mount ${index + 1}`}
                  onClick={() =>
                    onChange({
                      mounts: mounts.filter(
                        (_, candidate) => candidate !== index,
                      ),
                    })
                  }
                >
                  <Trash2Icon data-icon aria-hidden='true' />
                </Button>
              </div>
            </Field>
          ))}
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='self-start'
            onClick={() =>
              onChange({
                mounts: [
                  ...mounts,
                  { virtualPath: '/data', hostPath: '', access: 'read_only' },
                ],
              })
            }
          >
            <PlusIcon data-icon='inline-start' aria-hidden='true' />
            Add mount
          </Button>
        </FieldGroup>
      </InspectorSection>
      <InspectorSection
        title='Environment'
        description='Values are stored with this workflow and passed to Monty as environment variables.'
      >
        <FieldGroup className='gap-3'>
          {environment.map((binding, index) => (
            <Field key={`${binding.name}-${index}`}>
              <div className='flex items-end gap-2'>
                <Field className='min-w-0 flex-1'>
                  <Label htmlFor={`codeact-environment-name-${index}`}>
                    Variable name
                  </Label>
                  <Input
                    id={`codeact-environment-name-${index}`}
                    value={binding.name}
                    placeholder='API_TOKEN'
                    onChange={(event) =>
                      updateEnvironment(index, { name: event.target.value })
                    }
                  />
                </Field>
                <Field className='min-w-0 flex-1'>
                  <Label htmlFor={`codeact-environment-value-${index}`}>
                    Value
                  </Label>
                  <Input
                    id={`codeact-environment-value-${index}`}
                    value={binding.value}
                    placeholder='value'
                    onChange={(event) =>
                      updateEnvironment(index, { value: event.target.value })
                    }
                  />
                </Field>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  aria-label={`Remove environment variable ${index + 1}`}
                  onClick={() =>
                    onChange({
                      environment: environment.filter(
                        (_, candidate) => candidate !== index,
                      ),
                    })
                  }
                >
                  <Trash2Icon data-icon aria-hidden='true' />
                </Button>
              </div>
            </Field>
          ))}
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='self-start'
            onClick={() =>
              onChange({
                environment: [...environment, { name: '', value: '' }],
              })
            }
          >
            <PlusIcon data-icon='inline-start' aria-hidden='true' />
            Add variable
          </Button>
        </FieldGroup>
      </InspectorSection>
      <InspectorSection
        title='Clock access'
        description='Allow scripts to call date.today() and datetime.now().'
      >
        <Field orientation='horizontal'>
          <Label htmlFor='codeact-system-clock'>Expose system clock</Label>
          <Switch
            id='codeact-system-clock'
            checked={getBoolean(data, 'systemClock', true)}
            onCheckedChange={(systemClock) => onChange({ systemClock })}
          />
        </Field>
      </InspectorSection>
    </>
  );
}

function WorkflowNodeInspector({
  node,
  workflowId,
  executableNodes,
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
    enabled: node?.type === 'agent' || node?.type === 'codeact_agent',
  });
  const skills = useQuery({
    queryKey: ['skills'],
    queryFn: listSkills,
    enabled: node?.type === 'agent',
  });
  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: listWorkflows,
    enabled: node?.type === 'subworkflow',
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
      case 'codeact_agent': {
        const isCodeActAgent = node.type === 'codeact_agent';
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Identity'
              description='How this agent is identified on the workflow canvas.'
            >
              <TextField
                id='agent-name'
                label='Name'
                description='A short name shown on the workflow canvas.'
                value={getText(data, 'name')}
                onChange={(name) => updateData({ name })}
              />
              <TextareaField
                id='agent-description'
                label='Description'
                description='Briefly describe this agent’s responsibility for people reading the workflow.'
                value={getText(data, 'description')}
                onChange={(description) => updateData({ description })}
              />
            </InspectorSection>
            <InspectorSection
              title='Model and instructions'
              description='Choose the model configuration and define how the agent should behave.'
            >
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
                id='agent-instruction'
                label='Instruction'
                description='Give the agent its role, goals, constraints, and the expected output.'
                value={getText(data, 'instruction')}
                onChange={(instruction) => updateData({ instruction })}
                className='min-h-36 font-mono text-xs'
              />
              {!isCodeActAgent && (
                <TextField
                  id='agent-output-key'
                  label='Output key'
                  description='Optionally save the complete final response to this workflow state key.'
                  value={getText(data, 'outputKey')}
                  onChange={(outputKey) => updateData({ outputKey })}
                  placeholder='Output key'
                />
              )}
            </InspectorSection>
            {!isCodeActAgent && (
              <InspectorSection
                title='Generation controls'
                description='Optional sampling settings. Leave either field empty to use the model default.'
              >
                <FieldGroup className='grid grid-cols-2 gap-4'>
                  <Field>
                    <Label htmlFor='agent-temperature'>Temperature</Label>
                    <FieldDescription>
                      Controls variation (0–2).
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
                      Controls token diversity (0–1).
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
              </InspectorSection>
            )}
            {!isCodeActAgent && (
              <InspectorSection
                title='Skills'
                description='Attach local Agent Skills. Their instructions are added to this agent and their allowed tools restrict its selected tools.'
              >
                <Field>
                  <Label>Active skills</Label>
                  <SkillCombobox
                    skills={skills.data ?? []}
                    selectedNames={getPersonalSkillNames(data)}
                    isLoading={skills.isLoading}
                    onChange={(names) =>
                      updateData({
                        skillRefs: names.map((name) => ({
                          source: 'personal',
                          name,
                        })),
                      })
                    }
                  />
                </Field>
              </InspectorSection>
            )}
            <InspectorSection
              title='Tools'
              description='Select local Tool Apps or tools discovered from running MCP servers.'
            >
              <Field>
                <Label>Available tools</Label>
                <ToolCombobox
                  tools={tools.data ?? []}
                  selectedIds={getStringArray(data, 'toolIds')}
                  isLoading={tools.isLoading}
                  onChange={(toolIds) => updateData({ toolIds })}
                />
              </Field>
              <FieldGroup className='grid grid-cols-2 gap-4'>
                {isCodeActAgent && (
                  <Field>
                    <Label htmlFor='codeact-agent-max-iterations'>
                      Iteration limit
                    </Label>
                    <FieldDescription>
                      Maximum model turns to write or repair a script.
                    </FieldDescription>
                    <Input
                      id='codeact-agent-max-iterations'
                      type='number'
                      min='1'
                      max='50'
                      step='1'
                      value={getNumber(data, 'maxIterations') || 8}
                      onChange={(event) =>
                        updateData({
                          maxIterations: optionalNumber(event.target.value),
                        })
                      }
                    />
                  </Field>
                )}
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
            </InspectorSection>
            {isCodeActAgent && (
              <CodeActRuntimeFields data={data} onChange={updateData} />
            )}
          </FieldGroup>
        );
      }
      case 'remote_agent':
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Identity'
              description='How this service is identified on the workflow canvas.'
            >
              <TextField
                id='remote-agent-name'
                label='Name'
                description='A short name shown on the workflow canvas.'
                value={getText(data, 'name')}
                onChange={(name) => updateData({ name })}
              />
              <TextareaField
                id='remote-agent-description'
                label='Description'
                description='Explain what the remote service does and when this workflow should call it.'
                value={getText(data, 'description')}
                onChange={(description) => updateData({ description })}
              />
            </InspectorSection>
            <InspectorSection
              title='Connection'
              description='The remote endpoint Workrun invokes for this node.'
            >
              <TextField
                id='remote-agent-url'
                label='Service URL'
                description='The HTTPS endpoint used to invoke the remote agent service.'
                type='url'
                value={getText(data, 'url')}
                onChange={(url) => updateData({ url })}
              />
            </InspectorSection>
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
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Identity'
              description='How this app is identified on the workflow canvas.'
            >
              <TextField
                id='process-name'
                label='Name'
                description='A short name shown on the workflow canvas.'
                value={getText(data, 'name')}
                onChange={(name) => updateData({ name })}
              />
            </InspectorSection>
            <InspectorSection
              title='App connection'
              description='Choose the installed app this workflow node will run.'
            >
              <Field>
                <Label htmlFor='process-node'>App</Label>
                <FieldDescription>
                  The selected local app receives this node’s authorized State
                  view as JSON on stdin and returns its result with{' '}
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
                    The selected app is unavailable. Choose another installed
                    app.
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
            </InspectorSection>
          </FieldGroup>
        );
      }
      case 'subworkflow': {
        const selectedWorkflowId = getText(data, 'workflowId');
        const selectedWorkflow = workflows.data?.find(
          (workflow) => workflow.id === selectedWorkflowId,
        );
        const childOutputs =
          selectedWorkflow?.document.settings.outputSchema?.fields ?? [];
        const publishedOutputKeys = new Set(
          getNodeStateConfig(data).globalKeys,
        );
        const publishedOutputCount = childOutputs.filter((output) =>
          publishedOutputKeys.has(output.key),
        ).length;
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Referenced workflow'
              description='This node runs the selected saved workflow as an isolated child graph.'
            >
              <Field>
                <Label htmlFor='subworkflow-id'>Workflow</Label>
                <FieldDescription>
                  Changes to the referenced workflow apply the next time this
                  workflow runs.
                </FieldDescription>
                <Select
                  value={selectedWorkflowId}
                  onValueChange={(nextWorkflowId) => {
                    const workflow = workflows.data?.find(
                      (candidate) => candidate.id === nextWorkflowId,
                    );
                    updateData({
                      workflowId: nextWorkflowId,
                      workflowName: workflow?.document.settings.name ?? '',
                    });
                  }}
                >
                  <SelectTrigger id='subworkflow-id' className='w-full'>
                    <span className='flex flex-1 truncate text-left'>
                      {selectedWorkflow?.document.settings.name ||
                        (workflows.isLoading
                          ? 'Loading workflows…'
                          : 'Select a saved workflow')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {workflows.data
                        ?.filter((workflow) => workflow.id !== workflowId)
                        .map((workflow) => (
                          <SelectItem key={workflow.id} value={workflow.id}>
                            {workflow.document.settings.name ||
                              'Untitled workflow'}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {selectedWorkflowId && !selectedWorkflow ? (
                  <FieldDescription className='text-destructive'>
                    The selected workflow is unavailable. Choose another
                    workflow.
                  </FieldDescription>
                ) : null}
              </Field>
              {selectedWorkflow ? (
                <div className='border-primary/30 overflow-hidden rounded-xl border shadow-xs'>
                  <div className='border-primary/15 bg-primary/5 flex items-start justify-between gap-3 border-b px-4 py-3'>
                    <div>
                      <p className='text-sm font-medium'>
                        Child workflow outputs
                      </p>
                      <p className='text-muted-foreground mt-1 text-xs leading-5'>
                        Values returned by{' '}
                        {selectedWorkflow.document.settings.name ||
                          'this workflow'}
                        .
                      </p>
                    </div>
                    <Badge variant='secondary' className='shrink-0'>
                      {childOutputs.length} outputs
                    </Badge>
                  </div>
                  <div className='space-y-3 p-4'>
                    <div className='grid grid-cols-2 gap-2'>
                      <div className='bg-muted/40 rounded-lg border px-3 py-2.5'>
                        <p className='text-muted-foreground text-[11px]'>
                          Default location
                        </p>
                        <p className='mt-1 text-xs font-medium'>
                          This node’s private State
                        </p>
                      </div>
                      <div className='border-primary/25 bg-primary/5 rounded-lg border px-3 py-2.5'>
                        <p className='text-primary text-[11px]'>
                          Shared to Global State
                        </p>
                        <p className='mt-1 text-xs font-medium'>
                          {publishedOutputCount} of {childOutputs.length}{' '}
                          outputs
                        </p>
                      </div>
                    </div>
                    {childOutputs.length > 0 ? (
                      <div className='divide-y rounded-lg border'>
                        {childOutputs.map((output) => (
                          <div
                            key={output.id}
                            className='flex min-w-0 items-center justify-between gap-3 px-3 py-2.5'
                          >
                            <div className='min-w-0'>
                              <p className='truncate text-xs font-medium'>
                                {output.label || 'Untitled output'}
                              </p>
                              <p className='text-muted-foreground mt-0.5 truncate text-[11px]'>
                                <span className='font-mono'>{output.key}</span>
                                <span className='mx-1.5'>·</span>
                                {workflowOutputTypeLabels[output.type]}
                              </p>
                            </div>
                            <div className='flex shrink-0 items-center gap-1.5'>
                              <Badge
                                variant={
                                  publishedOutputKeys.has(output.key)
                                    ? 'default'
                                    : 'outline'
                                }
                              >
                                {publishedOutputKeys.has(output.key)
                                  ? 'Global'
                                  : 'Private'}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className='rounded-lg border border-dashed px-3 py-4'>
                        <p className='text-sm font-medium'>
                          No declared outputs
                        </p>
                        <p className='text-muted-foreground mt-1 text-xs leading-5'>
                          Add outputs in the child workflow’s settings to make
                          its result contract visible here.
                        </p>
                      </div>
                    )}
                    <p className='text-muted-foreground text-xs leading-5'>
                      Private outputs can be read by nodes allowed in State
                      access. Publish only the values the whole workflow needs.
                    </p>
                  </div>
                </div>
              ) : null}
            </InspectorSection>
          </FieldGroup>
        );
      }
      case 'if_else':
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection title='Node details'>
              <TextField
                id='if-else-label'
                label='Name'
                description='A short name shown on the workflow canvas.'
                value={getText(data, 'label')}
                onChange={(label) => updateData({ label })}
              />
            </InspectorSection>
            {(['true', 'false'] as const).map((branch) => {
              const current = getIfElseBranch(data, branch);
              const other = getIfElseBranch(
                data,
                branch === 'true' ? 'false' : 'true',
              );
              const isTrueBranch = branch === 'true';

              return (
                <FieldSet
                  key={branch}
                  className='bg-muted/20 gap-4 rounded-xl border p-4'
                >
                  <FieldLegend>
                    {isTrueBranch ? 'True branch' : 'False branch'}
                  </FieldLegend>
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
                </FieldSet>
              );
            })}
          </FieldGroup>
        );
      case 'switch': {
        const cases = getSwitchCases(data);
        const defaultCase = getSwitchDefault(data);

        return (
          <FieldGroup className='gap-7'>
            <InspectorSection title='Node details'>
              <TextField
                id='switch-label'
                label='Name'
                description='A short name shown on the workflow canvas.'
                value={getText(data, 'label')}
                onChange={(label) => updateData({ label })}
              />
            </InspectorSection>
            <FieldSet className='bg-muted/20 gap-4 rounded-xl border p-4'>
              <div className='flex items-center justify-between gap-2'>
                <FieldLegend>Cases</FieldLegend>
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
                  <PlusIcon data-icon='inline-start' />
                  Add case
                </Button>
              </div>
              <FieldDescription>
                Cases are evaluated from top to bottom. The first matching
                condition determines the outgoing branch.
              </FieldDescription>
              <FieldGroup className='gap-4'>
                {cases.map((switchCase, index) => (
                  <FieldSet
                    key={switchCase.id}
                    className='bg-background gap-4 rounded-lg border p-3'
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <FieldLegend variant='label'>
                        Case {index + 1}
                      </FieldLegend>
                      <Button
                        type='button'
                        size='icon-sm'
                        variant='ghost'
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
                  </FieldSet>
                ))}
              </FieldGroup>
            </FieldSet>
            <FieldSet className='bg-card gap-4 rounded-xl border p-4 shadow-xs'>
              <FieldLegend>Default branch</FieldLegend>
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
            </FieldSet>
          </FieldGroup>
        );
      }
      case 'human_review':
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Review request'
              description='The workflow pauses here. Connect the Approved and Rejected outputs to choose what happens next.'
            >
              <TextField
                id='human-review-title'
                label='Title'
                value={getText(data, 'title')}
                onChange={(title) => updateData({ title })}
              />
              <TextareaField
                id='human-review-description'
                label='Description'
                description='Explain the decision the reviewer needs to make.'
                value={getText(data, 'description')}
                onChange={(description) => updateData({ description })}
              />
              <TextField
                id='human-review-content-key'
                label='Content key'
                description='The workflow state value shown to the reviewer.'
                value={getText(data, 'contentKey')}
                onChange={(contentKey) => updateData({ contentKey })}
                placeholder='Content key'
              />
              <TextField
                id='human-review-context-keys'
                label='Context keys'
                description='Comma-separated read-only state keys shown below the review content.'
                value={getStringArray(data, 'contextKeys').join(', ')}
                onChange={(value) =>
                  updateData({
                    contextKeys: value
                      .split(',')
                      .map((key) => key.trim())
                      .filter(Boolean),
                  })
                }
              />
              <Field orientation='horizontal'>
                <div className='flex flex-1 flex-col gap-1'>
                  <Label htmlFor='human-review-editable'>Allow editing</Label>
                  <FieldDescription>
                    Write the edited text back to this content key when
                    approved.
                  </FieldDescription>
                </div>
                <Switch
                  id='human-review-editable'
                  checked={getBoolean(data, 'editable', false)}
                  onCheckedChange={(editable) => updateData({ editable })}
                />
              </Field>
            </InspectorSection>
          </FieldGroup>
        );
      case 'ask_user_question': {
        const options = getAskUserQuestionOptions(data);
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Question'
              description='The workflow pauses here and continues through the output for the selected option.'
            >
              <TextField
                id='ask-user-question-title'
                label='Question'
                value={getText(data, 'title')}
                onChange={(title) => updateData({ title })}
              />
              <TextareaField
                id='ask-user-question-description'
                label='Description'
                description='Optional context shown before the choices.'
                value={getText(data, 'description')}
                onChange={(description) => updateData({ description })}
              />
            </InspectorSection>
            <FieldSet className='bg-muted/20 gap-4 rounded-xl border p-4'>
              <div className='flex items-center justify-between gap-2'>
                <FieldLegend>Options</FieldLegend>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() =>
                    updateData({
                      options: [
                        ...options,
                        {
                          id: crypto.randomUUID(),
                          label: `Option ${options.length + 1}`,
                        },
                      ],
                    })
                  }
                >
                  <PlusIcon data-icon='inline-start' />
                  Add option
                </Button>
              </div>
              <FieldDescription>
                Each option has one canvas output. Its identifier stays stable
                when its label changes.
              </FieldDescription>
              <FieldGroup className='gap-4'>
                {options.map((option, index) => (
                  <FieldSet
                    key={option.id}
                    className='bg-background gap-4 rounded-lg border p-3'
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <FieldLegend variant='label'>
                        Option {index + 1}
                      </FieldLegend>
                      <Button
                        type='button'
                        size='icon-sm'
                        variant='ghost'
                        aria-label={`Remove option ${index + 1}`}
                        disabled={options.length === 1}
                        onClick={() =>
                          updateData({
                            options: options.filter(
                              (item) => item.id !== option.id,
                            ),
                          })
                        }
                      >
                        <Trash2Icon aria-hidden='true' />
                      </Button>
                    </div>
                    <TextField
                      id={`ask-user-question-option-${option.id}-label`}
                      label='Label'
                      value={option.label}
                      onChange={(label) =>
                        updateData({
                          options: options.map((item) =>
                            item.id === option.id ? { ...item, label } : item,
                          ),
                        })
                      }
                    />
                    <TextField
                      id={`ask-user-question-option-${option.id}-description`}
                      label='Description'
                      value={option.description ?? ''}
                      onChange={(description) =>
                        updateData({
                          options: options.map((item) =>
                            item.id === option.id
                              ? { ...item, description }
                              : item,
                          ),
                        })
                      }
                    />
                  </FieldSet>
                ))}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        );
      }
      case 'start':
      case 'end':
      case 'group':
        return (
          <FieldGroup>
            <InspectorSection title='Node details'>
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
            </InspectorSection>
          </FieldGroup>
        );
      case 'terminate':
        return (
          <FieldGroup className='gap-7'>
            <InspectorSection
              title='Terminate task'
              description='Immediately ends this workflow and propagates the termination through every parent workflow.'
            >
              <FieldDescription>
                Do not connect this node to End. It stops all later workflow
                steps, including steps after the containing subworkflow.
              </FieldDescription>
              <FieldDescription>
                Work that is already running in parallel cannot be cancelled.
              </FieldDescription>
            </InspectorSection>
            <InspectorSection title='Node details'>
              <TextField
                id='terminate-label'
                label='Name'
                description='A short name shown on the workflow canvas.'
                value={getText(data, 'label')}
                onChange={(label) => updateData({ label })}
              />
            </InspectorSection>
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
      disablePointerDismissal
      defaultHorizontalSnapPoint='31rem'
      horizontalSnapPoints={['31rem', '48rem', '64rem']}
      swipeDirection='right'
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DrawerContent className='sm:[--drawer-content-width:32rem]'>
        <DrawerHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[16px_16px]' />
          <DrawerTitle className='relative text-lg'>Edit {title}</DrawerTitle>
          <DrawerDescription className='relative mt-1 leading-5'>
            Changes apply to the workflow immediately.
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
        <div className='min-h-0 overflow-y-auto px-5 py-6'>
          {renderFields()}
          {node && supportsNodeState(node.type) ? (
            <NodeStateFields
              node={node}
              executableNodes={executableNodes}
              onChange={(state) => updateData({ state })}
            />
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function NodeStateFields({
  node,
  executableNodes,
  onChange,
}: {
  node: Node;
  executableNodes: Node[];
  onChange: (state: WorkflowNodeStateConfig) => void;
}) {
  const config = getNodeStateConfig(node.data);
  const readers = config.readers.filter((id) => id !== node.id);
  const availableReaders = executableNodes
    .filter((candidate) => candidate.id !== node.id)
    .map((candidate) => ({
      id: candidate.id,
      name:
        getText(candidate.data, 'workflowName') ||
        getText(candidate.data, 'name') ||
        getText(candidate.data, 'title') ||
        nodeTitles[candidate.type ?? ''] ||
        'Untitled node',
    }));
  const setReaders = (nextReaders: string[]) =>
    onChange({
      access: { readers: nextReaders },
      globalKeys: config.globalKeys,
    });

  return (
    <FieldGroup className='mt-7 gap-7'>
      <InspectorSection
        title='State access'
        description='This node always owns its private State. Grant selected nodes read-only access to all of it.'
      >
        <Field>
          <Label>Allowed readers</Label>
          <FieldDescription>
            By default, no other node can read this node’s private State.
          </FieldDescription>
          <NodeCombobox
            nodes={availableReaders}
            selectedIds={readers}
            onChange={setReaders}
          />
        </Field>
      </InspectorSection>
      {supportsGlobalPublication(node.type) ? (
        <InspectorSection
          title='Global State publication'
          description='Outputs are private by default. List the output keys this node should publish for every node to read and write.'
        >
          <TextField
            id={`${node.id}-global-state-keys`}
            label='Published output keys'
            description='Separate keys with commas, for example summary, score.'
            value={config.globalKeys.join(', ')}
            placeholder='summary, score'
            onChange={(value) =>
              onChange({
                access: { readers },
                globalKeys: value
                  .split(',')
                  .map((key) => key.trim())
                  .filter(Boolean),
              })
            }
          />
        </InspectorSection>
      ) : null}
    </FieldGroup>
  );
}

function NodeCombobox({
  nodes,
  selectedIds,
  onChange,
}: {
  nodes: { id: string; name: string }[];
  selectedIds: string[];
  onChange: (nodeIds: string[]) => void;
}) {
  const anchor = useComboboxAnchor();
  const selected = nodes.filter((node) => selectedIds.includes(node.id));

  return (
    <Combobox
      items={nodes}
      multiple
      value={selected}
      onValueChange={(selected) => onChange(selected.map((node) => node.id))}
      itemToStringValue={(node) => node.name}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {selected.map((node) => (
            <ComboboxChip key={node.id}>{node.name}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput placeholder='Select workflow nodes…' />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No other executable nodes are available.</ComboboxEmpty>
        <ComboboxList>
          {nodes.map((node) => (
            <ComboboxItem key={node.id} value={node}>
              {node.name}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function InspectorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <FieldSet className='bg-card gap-4 rounded-xl border p-4 shadow-xs'>
      <div className='flex flex-col gap-1'>
        <FieldLegend>{title}</FieldLegend>
        {description ? (
          <FieldDescription>{description}</FieldDescription>
        ) : null}
      </div>
      <FieldGroup className='gap-4'>{children}</FieldGroup>
    </FieldSet>
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
  const unavailableSelectedTools = selectedIds
    .filter((id) => !tools.some((tool) => tool.id === id))
    .map(unavailableTool);
  const selectedTools = [
    ...tools.filter((tool) => selectedIds.includes(tool.id)),
    ...unavailableSelectedTools,
  ];
  const allTools = [...tools, ...unavailableSelectedTools];
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
      items={allTools}
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
          {unavailableSelectedTools.length ? (
            <ComboboxGroup>
              <ComboboxLabel>Unavailable selections</ComboboxLabel>
              {unavailableSelectedTools.map((tool) => (
                <ToolComboboxItem key={tool.id} tool={tool} unavailable />
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

function SkillCombobox({
  skills,
  selectedNames,
  isLoading = false,
  onChange,
}: {
  skills: SkillSummary[];
  selectedNames: string[];
  isLoading?: boolean;
  onChange: (names: string[]) => void;
}) {
  const anchor = useComboboxAnchor();
  const unavailableSkills: Pick<
    SkillSummary,
    'name' | 'description' | 'allowedTools'
  >[] = selectedNames
    .filter((name) => !skills.some((skill) => skill.name === name))
    .map((name) => ({
      name,
      description: 'This local Skill is no longer available.',
      allowedTools: [],
    }));
  const selectedSkills = [
    ...skills.filter((skill) => selectedNames.includes(skill.name)),
    ...unavailableSkills,
  ];
  const allSkills = [...skills, ...unavailableSkills];

  return (
    <Combobox
      items={allSkills}
      multiple
      value={selectedSkills}
      disabled={isLoading}
      onValueChange={(selected) =>
        onChange(selected.map((skill) => skill.name))
      }
      itemToStringValue={(skill) => `${skill.name} ${skill.description}`}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {selectedSkills.map((skill) => (
            <ComboboxChip key={skill.name}>{skill.name}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          disabled={isLoading}
          placeholder={isLoading ? 'Loading skills…' : 'Search skills…'}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No local Skills found.</ComboboxEmpty>
        <ComboboxList>
          {allSkills.map((skill) => (
            <ComboboxItem
              key={skill.name}
              value={skill}
              disabled={unavailableSkills.includes(skill)}
            >
              <span className='flex min-w-0 flex-col'>
                <span className='truncate'>{skill.name}</span>
                <span className='text-muted-foreground truncate text-xs'>
                  {skill.description}
                </span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ToolComboboxItem({
  tool,
  unavailable = false,
}: {
  tool: Awaited<ReturnType<typeof listTools>>[number];
  unavailable?: boolean;
}) {
  return (
    <ComboboxItem value={tool} disabled={unavailable}>
      <span className='flex min-w-0 flex-col'>
        <span className='truncate'>{tool.displayName}</span>
        <span className='text-muted-foreground truncate text-xs'>
          {tool.description}
        </span>
      </span>
    </ComboboxItem>
  );
}

function unavailableTool(id: string): ToolDefinition {
  const [, serverId, toolName] = id.split(':');
  return {
    id,
    source: 'mcp',
    sourceId: serverId,
    sourceName: 'Stopped MCP server',
    displayName: `${toolName || id} (unavailable)`,
    name: toolName || id,
    description:
      'This tool is selected but its MCP server is not currently running.',
    version: 'mcp',
    inputSchema: {},
    outputSchema: {},
    riskLevel: 'low',
    permissions: [],
    executionPolicy: 'ask_every_time',
  };
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
