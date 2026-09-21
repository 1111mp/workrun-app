import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  TestTubeDiagonalIcon,
  Trash2Icon,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { EvaluationCase } from '@/services/evaluation';
import type { ToolDefinition } from '@/services/tool';

import { toolCallDraft } from './assertion-utils';
import type {
  AssertionOperator,
  AssertionSubject,
  MatchAlgorithm,
  NodeOutputAssertionDraft,
  NodeTextAssertionDraft,
  NodeToolAssertionDraft,
  NodeTrajectoryDraft,
  RouteAssertionDraft,
  SafetyAssertionDraft,
  SafetyTarget,
  ToolFixtureDraft,
  ToolTrajectoryDraft,
  VisualAssertion,
  WorkflowRouteOption,
} from './types';
import { selectedToolLabel, toolLabel } from './workflow-utils';

type NodeOption = { id: string; label: string };

type CaseEditorDialogModel = {
  caseDialogOpen: boolean;
  setCaseDialogOpen: (open: boolean) => void;
  saving: boolean;
  editingCase?: EvaluationCase;
  caseName: string;
  setCaseName: (name: string) => void;
  caseDescription: string;
  setCaseDescription: (description: string) => void;
  caseInput: string;
  setCaseInput: (input: string) => void;
  assertionDrafts: VisualAssertion[];
  setAssertionDrafts: Dispatch<SetStateAction<VisualAssertion[]>>;
  toolTrajectory: ToolTrajectoryDraft;
  setToolTrajectory: Dispatch<SetStateAction<ToolTrajectoryDraft>>;
  nodeTrajectory: NodeTrajectoryDraft;
  setNodeTrajectory: Dispatch<SetStateAction<NodeTrajectoryDraft>>;
  routeDrafts: RouteAssertionDraft[];
  setRouteDrafts: Dispatch<SetStateAction<RouteAssertionDraft[]>>;
  nodeOutputDrafts: NodeOutputAssertionDraft[];
  setNodeOutputDrafts: Dispatch<SetStateAction<NodeOutputAssertionDraft[]>>;
  nodeTextDrafts: NodeTextAssertionDraft[];
  setNodeTextDrafts: Dispatch<SetStateAction<NodeTextAssertionDraft[]>>;
  nodeToolDrafts: NodeToolAssertionDraft[];
  setNodeToolDrafts: Dispatch<SetStateAction<NodeToolAssertionDraft[]>>;
  fixtureDrafts: ToolFixtureDraft[];
  setFixtureDrafts: Dispatch<SetStateAction<ToolFixtureDraft[]>>;
  safetyDrafts: SafetyAssertionDraft[];
  setSafetyDrafts: Dispatch<SetStateAction<SafetyAssertionDraft[]>>;
  configuredTools: ToolDefinition[];
  configuredWorkflowNodes: NodeOption[];
  configuredRoutes: WorkflowRouteOption[];
  configuredRouteNodes: WorkflowRouteOption[];
  configuredAgentNodes: NodeOption[];
  assertionsJson: string;
  saveCase: () => Promise<void>;
};

export function CaseEditorDialog({
  editor,
}: {
  editor: CaseEditorDialogModel;
}) {
  const { t } = useTranslation();
  const {
    caseDialogOpen,
    setCaseDialogOpen,
    saving,
    editingCase,
    caseName,
    setCaseName,
    caseDescription,
    setCaseDescription,
    caseInput,
    setCaseInput,
    assertionDrafts,
    setAssertionDrafts,
    toolTrajectory,
    setToolTrajectory,
    nodeTrajectory,
    setNodeTrajectory,
    routeDrafts,
    setRouteDrafts,
    nodeOutputDrafts,
    setNodeOutputDrafts,
    nodeTextDrafts,
    setNodeTextDrafts,
    nodeToolDrafts,
    setNodeToolDrafts,
    fixtureDrafts,
    setFixtureDrafts,
    safetyDrafts,
    setSafetyDrafts,
    configuredTools,
    configuredWorkflowNodes,
    configuredRoutes,
    configuredRouteNodes,
    configuredAgentNodes,
    assertionsJson,
    saveCase,
  } = editor;

  return (
    <Dialog open={caseDialogOpen} onOpenChange={setCaseDialogOpen}>
      <DialogContent
        className='max-w-3xl! gap-0 overflow-hidden p-0'
        showCloseButton={!saving}
      >
        <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
          <div className='relative flex items-start gap-3'>
            <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
              <TestTubeDiagonalIcon className='size-5' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg'>
                {editingCase
                  ? t('evaluations.editCase')
                  : t('evaluations.addCase')}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-xl leading-5'>
                {t('evaluations.caseDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
          <FieldGroup className='gap-7'>
            <FieldSet>
              <FieldLegend>{t('evaluations.caseDetails')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.caseDetailsDescription')}
              </FieldDescription>
              <FieldGroup className='gap-5'>
                <Field>
                  <FieldLabel htmlFor='evaluation-case-name'>
                    {t('common.name')}
                  </FieldLabel>
                  <Input
                    id='evaluation-case-name'
                    value={caseName}
                    onChange={(event) => setCaseName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor='evaluation-case-description'>
                    {t('common.description')}
                  </FieldLabel>
                  <Textarea
                    id='evaluation-case-description'
                    className='min-h-20 resize-y'
                    value={caseDescription}
                    onChange={(event) => setCaseDescription(event.target.value)}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
              <FieldLegend>{t('evaluations.workflowInput')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.workflowInputDescription')}
              </FieldDescription>
              <FieldGroup className='gap-5'>
                <Field>
                  <FieldLabel htmlFor='evaluation-case-input'>
                    {t('evaluations.inputJson')}
                  </FieldLabel>
                  <Textarea
                    id='evaluation-case-input'
                    className='min-h-24 font-mono text-xs leading-5'
                    value={caseInput}
                    onChange={(event) => setCaseInput(event.target.value)}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet className='rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>{t('evaluations.assertionRules')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.assertionRulesDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    setAssertionDrafts((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        subject: 'final_json',
                        path: '$.',
                        operator: 'equals',
                        expected: '',
                      },
                    ])
                  }
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addRule')}
                </Button>
              </div>
              <FieldGroup className='mt-4 gap-3'>
                {assertionDrafts.map((assertion, index) => (
                  <div
                    key={assertion.id}
                    className='bg-background rounded-lg border p-3'
                  >
                    <div className='mb-3 flex items-center justify-between'>
                      <span className='text-sm font-medium'>
                        {t('evaluations.rule', { index: index + 1 })}
                      </span>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon-sm'
                        aria-label={t('evaluations.deleteRule', {
                          index: index + 1,
                        })}
                        onClick={() =>
                          setAssertionDrafts((current) =>
                            current.filter((item) => item.id !== assertion.id),
                          )
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <div className='grid gap-3 sm:grid-cols-2'>
                      <Field>
                        <FieldLabel>
                          {t('evaluations.assertionTarget')}
                        </FieldLabel>
                        <Select
                          value={assertion.subject}
                          items={[
                            {
                              value: 'final_json',
                              label: t('evaluations.finalOutputField'),
                            },
                            {
                              value: 'final_text',
                              label: t('evaluations.finalOutputText'),
                            },
                          ]}
                          onValueChange={(value) =>
                            setAssertionDrafts((current) =>
                              current.map((item) =>
                                item.id === assertion.id
                                  ? {
                                      ...item,
                                      subject: value as AssertionSubject,
                                      path: value === 'final_json' ? '$.' : '',
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value='final_json'>
                                {t('evaluations.finalOutputField')}
                              </SelectItem>
                              <SelectItem value='final_text'>
                                {t('evaluations.finalOutputText')}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      {assertion.subject === 'final_json' ? (
                        <Field>
                          <FieldLabel>{t('evaluations.fieldPath')}</FieldLabel>
                          <Input
                            value={assertion.path}
                            placeholder='$.decision'
                            onChange={(event) =>
                              setAssertionDrafts((current) =>
                                current.map((item) =>
                                  item.id === assertion.id
                                    ? { ...item, path: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                      ) : null}
                      <Field>
                        <FieldLabel>{t('evaluations.operator')}</FieldLabel>
                        <Select
                          value={assertion.operator}
                          items={
                            assertion.subject === 'final_json'
                              ? [
                                  {
                                    value: 'equals',
                                    label: t('evaluations.equals'),
                                  },
                                  {
                                    value: 'not_equals',
                                    label: t('evaluations.notEquals'),
                                  },
                                  {
                                    value: 'contains',
                                    label: t('evaluations.contains'),
                                  },
                                  {
                                    value: 'not_contains',
                                    label: t('evaluations.notContains'),
                                  },
                                  {
                                    value: 'exists',
                                    label: t('evaluations.fieldExists'),
                                  },
                                ]
                              : [
                                  {
                                    value: 'exact',
                                    label: t('evaluations.exactMatch'),
                                  },
                                  {
                                    value: 'contains',
                                    label: t('evaluations.containsText'),
                                  },
                                  {
                                    value: 'levenshtein',
                                    label: t('evaluations.textSimilarity'),
                                  },
                                ]
                          }
                          onValueChange={(value) =>
                            setAssertionDrafts((current) =>
                              current.map((item) =>
                                item.id === assertion.id
                                  ? {
                                      ...item,
                                      operator: value as AssertionOperator,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {assertion.subject === 'final_json' ? (
                                <>
                                  <SelectItem value='equals'>
                                    {t('evaluations.equals')}
                                  </SelectItem>
                                  <SelectItem value='not_equals'>
                                    {t('evaluations.notEquals')}
                                  </SelectItem>
                                  <SelectItem value='contains'>
                                    {t('evaluations.contains')}
                                  </SelectItem>
                                  <SelectItem value='not_contains'>
                                    {t('evaluations.notContains')}
                                  </SelectItem>
                                  <SelectItem value='exists'>
                                    {t('evaluations.fieldExists')}
                                  </SelectItem>
                                </>
                              ) : (
                                <>
                                  <SelectItem value='exact'>
                                    {t('evaluations.exactMatch')}
                                  </SelectItem>
                                  <SelectItem value='contains'>
                                    {t('evaluations.containsText')}
                                  </SelectItem>
                                  <SelectItem value='levenshtein'>
                                    {t('evaluations.textSimilarity')}
                                  </SelectItem>
                                </>
                              )}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      {assertion.operator !== 'exists' ? (
                        <Field>
                          <FieldLabel>
                            {t('evaluations.expectedValue')}
                          </FieldLabel>
                          <Input
                            value={assertion.expected}
                            placeholder={
                              assertion.subject === 'final_json'
                                ? t('evaluations.expectedJsonValue')
                                : t('evaluations.expectedText')
                            }
                            onChange={(event) =>
                              setAssertionDrafts((current) =>
                                current.map((item) =>
                                  item.id === assertion.id
                                    ? {
                                        ...item,
                                        expected: event.target.value,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!assertionDrafts.length ? (
                  <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-5 text-center text-sm'>
                    {t('evaluations.noAssertionRules')}
                  </p>
                ) : null}
              </FieldGroup>
            </FieldSet>

            <FieldSet className='rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>
                    {t('evaluations.agentMessageAssertions')}
                  </FieldLegend>
                  <FieldDescription>
                    {t('evaluations.agentMessageAssertionsDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={!configuredAgentNodes.length}
                  onClick={() => {
                    const node = configuredAgentNodes[0];
                    if (node)
                      setNodeTextDrafts((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          nodeId: node.id,
                          algorithm: 'contains',
                          expected: '',
                        },
                      ]);
                  }}
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addAgentMessageAssertion')}
                </Button>
              </div>
              {configuredAgentNodes.length ? (
                <FieldGroup className='mt-4 gap-3'>
                  {nodeTextDrafts.map((draft, index) => (
                    <div
                      key={draft.id}
                      className='bg-background grid gap-3 rounded-lg border p-3 sm:grid-cols-3'
                    >
                      <Field>
                        <FieldLabel>{t('evaluations.agentNode')}</FieldLabel>
                        <Select
                          value={draft.nodeId}
                          items={configuredAgentNodes.map((node) => ({
                            value: node.id,
                            label: node.label,
                          }))}
                          onValueChange={(nodeId) =>
                            setNodeTextDrafts((current) =>
                              current.map((item) =>
                                item.id === draft.id && nodeId
                                  ? { ...item, nodeId }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {configuredAgentNodes.map((node) => (
                                <SelectItem key={node.id} value={node.id}>
                                  {node.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.operator')}</FieldLabel>
                        <Select
                          value={draft.algorithm}
                          items={[
                            {
                              value: 'exact',
                              label: t('evaluations.exactMatch'),
                            },
                            {
                              value: 'contains',
                              label: t('evaluations.containsText'),
                            },
                            {
                              value: 'levenshtein',
                              label: t('evaluations.textSimilarity'),
                            },
                          ]}
                          onValueChange={(algorithm) =>
                            setNodeTextDrafts((current) =>
                              current.map((item) =>
                                item.id === draft.id && algorithm
                                  ? {
                                      ...item,
                                      algorithm: algorithm as MatchAlgorithm,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value='exact'>
                                {t('evaluations.exactMatch')}
                              </SelectItem>
                              <SelectItem value='contains'>
                                {t('evaluations.containsText')}
                              </SelectItem>
                              <SelectItem value='levenshtein'>
                                {t('evaluations.textSimilarity')}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.expectedText')}</FieldLabel>
                        <div className='flex gap-2'>
                          <Input
                            value={draft.expected}
                            onChange={(event) =>
                              setNodeTextDrafts((current) =>
                                current.map((item) =>
                                  item.id === draft.id
                                    ? {
                                        ...item,
                                        expected: event.target.value,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t(
                              'evaluations.deleteAgentMessageAssertion',
                              { index: index + 1 },
                            )}
                            onClick={() =>
                              setNodeTextDrafts((current) =>
                                current.filter((item) => item.id !== draft.id),
                              )
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </Field>
                    </div>
                  ))}
                  {!nodeTextDrafts.length ? (
                    <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                      {t('evaluations.noAgentMessageAssertions')}
                    </p>
                  ) : null}
                </FieldGroup>
              ) : (
                <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                  {t('evaluations.noAgentNodes')}
                </p>
              )}
            </FieldSet>

            <FieldSet className='rounded-xl border border-teal-500/20 bg-teal-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>
                    {t('evaluations.nodeToolAssertions')}
                  </FieldLegend>
                  <FieldDescription>
                    {t('evaluations.nodeToolAssertionsDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={
                    !configuredAgentNodes.length || !configuredTools.length
                  }
                  onClick={() => {
                    const node = configuredAgentNodes[0];
                    const tool = configuredTools[0];
                    if (node && tool)
                      setNodeToolDrafts((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          nodeId: node.id,
                          toolName: tool.name,
                          count: 1,
                        },
                      ]);
                  }}
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addNodeToolAssertion')}
                </Button>
              </div>
              <FieldGroup className='mt-4 gap-3'>
                {nodeToolDrafts.map((draft, index) => (
                  <div
                    key={draft.id}
                    className='bg-background grid gap-3 rounded-lg border p-3 sm:grid-cols-4'
                  >
                    <Field>
                      <FieldLabel>{t('evaluations.agentNode')}</FieldLabel>
                      <Select
                        value={draft.nodeId}
                        items={configuredAgentNodes.map((node) => ({
                          value: node.id,
                          label: node.label,
                        }))}
                        onValueChange={(nodeId) =>
                          setNodeToolDrafts((current) =>
                            current.map((item) =>
                              item.id === draft.id && nodeId
                                ? { ...item, nodeId }
                                : item,
                            ),
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {configuredAgentNodes.map((node) => (
                              <SelectItem key={node.id} value={node.id}>
                                {node.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>{t('evaluations.tool')}</FieldLabel>
                      <Select
                        value={draft.toolName}
                        items={configuredTools.map((tool) => ({
                          value: tool.name,
                          label: toolLabel(tool),
                        }))}
                        onValueChange={(toolName) =>
                          setNodeToolDrafts((current) =>
                            current.map((item) =>
                              item.id === draft.id && toolName
                                ? { ...item, toolName }
                                : item,
                            ),
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {configuredTools.map((tool) => (
                              <SelectItem key={tool.id} value={tool.name}>
                                {toolLabel(tool)}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>{t('evaluations.callCount')}</FieldLabel>
                      <Input
                        type='number'
                        min={1}
                        value={draft.count}
                        onChange={(event) =>
                          setNodeToolDrafts((current) =>
                            current.map((item) =>
                              item.id === draft.id
                                ? {
                                    ...item,
                                    count: Math.max(
                                      1,
                                      Number(event.target.value) || 1,
                                    ),
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon-sm'
                      className='self-end'
                      aria-label={t('evaluations.deleteNodeToolAssertion', {
                        index: index + 1,
                      })}
                      onClick={() =>
                        setNodeToolDrafts((current) =>
                          current.filter((item) => item.id !== draft.id),
                        )
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
                {!nodeToolDrafts.length ? (
                  <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                    {t('evaluations.noNodeToolAssertions')}
                  </p>
                ) : null}
              </FieldGroup>
            </FieldSet>

            <FieldSet className='rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>
                    {t('evaluations.nodeOutputAssertions')}
                  </FieldLegend>
                  <FieldDescription>
                    {t('evaluations.nodeOutputAssertionsDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={!configuredWorkflowNodes.length}
                  onClick={() => {
                    const node = configuredWorkflowNodes[0];
                    if (!node) return;
                    setNodeOutputDrafts((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        nodeId: node.id,
                        path: '$.',
                        operator: 'equals',
                        expected: '',
                      },
                    ]);
                  }}
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addNodeOutputAssertion')}
                </Button>
              </div>
              {configuredWorkflowNodes.length ? (
                <FieldGroup className='mt-4 gap-3'>
                  {nodeOutputDrafts.map((draft, index) => (
                    <div
                      key={draft.id}
                      className='bg-background grid gap-3 rounded-lg border p-3 sm:grid-cols-2'
                    >
                      <Field>
                        <FieldLabel>{t('evaluations.outputNode')}</FieldLabel>
                        <Select
                          value={draft.nodeId}
                          items={configuredWorkflowNodes.map((node) => ({
                            value: node.id,
                            label: node.label,
                          }))}
                          onValueChange={(nodeId) =>
                            setNodeOutputDrafts((current) =>
                              current.map((item) =>
                                item.id === draft.id && nodeId
                                  ? { ...item, nodeId }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t('evaluations.selectWorkflowNode')}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {configuredWorkflowNodes.map((node) => (
                                <SelectItem key={node.id} value={node.id}>
                                  {node.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.fieldPath')}</FieldLabel>
                        <Input
                          value={draft.path}
                          placeholder='$.riskLevel'
                          onChange={(event) =>
                            setNodeOutputDrafts((current) =>
                              current.map((item) =>
                                item.id === draft.id
                                  ? { ...item, path: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.operator')}</FieldLabel>
                        <Select
                          value={draft.operator}
                          items={[
                            {
                              value: 'equals',
                              label: t('evaluations.equals'),
                            },
                            {
                              value: 'not_equals',
                              label: t('evaluations.notEquals'),
                            },
                            {
                              value: 'contains',
                              label: t('evaluations.contains'),
                            },
                            {
                              value: 'not_contains',
                              label: t('evaluations.notContains'),
                            },
                            {
                              value: 'exists',
                              label: t('evaluations.fieldExists'),
                            },
                          ]}
                          onValueChange={(operator) =>
                            setNodeOutputDrafts((current) =>
                              current.map((item) =>
                                item.id === draft.id && operator
                                  ? {
                                      ...item,
                                      operator:
                                        operator as NodeOutputAssertionDraft['operator'],
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value='equals'>
                                {t('evaluations.equals')}
                              </SelectItem>
                              <SelectItem value='not_equals'>
                                {t('evaluations.notEquals')}
                              </SelectItem>
                              <SelectItem value='contains'>
                                {t('evaluations.contains')}
                              </SelectItem>
                              <SelectItem value='not_contains'>
                                {t('evaluations.notContains')}
                              </SelectItem>
                              <SelectItem value='exists'>
                                {t('evaluations.fieldExists')}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>
                          {t('evaluations.expectedValue')}
                        </FieldLabel>
                        <div className='flex gap-2'>
                          <Input
                            value={draft.expected}
                            disabled={draft.operator === 'exists'}
                            onChange={(event) =>
                              setNodeOutputDrafts((current) =>
                                current.map((item) =>
                                  item.id === draft.id
                                    ? {
                                        ...item,
                                        expected: event.target.value,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t(
                              'evaluations.deleteNodeOutputAssertion',
                              { index: index + 1 },
                            )}
                            onClick={() =>
                              setNodeOutputDrafts((current) =>
                                current.filter((item) => item.id !== draft.id),
                              )
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </Field>
                    </div>
                  ))}
                  {!nodeOutputDrafts.length ? (
                    <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                      {t('evaluations.noNodeOutputAssertions')}
                    </p>
                  ) : null}
                </FieldGroup>
              ) : (
                <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                  {t('evaluations.noWorkflowNodes')}
                </p>
              )}
            </FieldSet>

            <FieldSet className='rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>{t('evaluations.routeAssertions')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.routeAssertionsDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={!configuredRoutes.length}
                  onClick={() => {
                    const route = configuredRoutes[0];
                    if (!route) return;
                    setRouteDrafts((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        nodeId: route.nodeId,
                        expectedRoute: route.route,
                      },
                    ]);
                  }}
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addRouteAssertion')}
                </Button>
              </div>
              {configuredRoutes.length ? (
                <FieldGroup className='mt-4 gap-3'>
                  {routeDrafts.map((draft, index) => {
                    const routesForNode = configuredRoutes.filter(
                      (route) => route.nodeId === draft.nodeId,
                    );
                    return (
                      <div
                        key={draft.id}
                        className='bg-background grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]'
                      >
                        <Field>
                          <FieldLabel>{t('evaluations.routeNode')}</FieldLabel>
                          <Select
                            value={draft.nodeId}
                            items={configuredRouteNodes.map((route) => ({
                              value: route.nodeId,
                              label: route.nodeLabel,
                            }))}
                            onValueChange={(nodeId) => {
                              const firstRoute = configuredRoutes.find(
                                (route) => route.nodeId === nodeId,
                              );
                              setRouteDrafts((current) =>
                                current.map((item) =>
                                  item.id === draft.id && nodeId && firstRoute
                                    ? {
                                        ...item,
                                        nodeId,
                                        expectedRoute: firstRoute.route,
                                      }
                                    : item,
                                ),
                              );
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={t('evaluations.selectRouteNode')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {configuredRouteNodes.map((route) => (
                                  <SelectItem
                                    key={route.nodeId}
                                    value={route.nodeId}
                                  >
                                    {route.nodeLabel}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>
                            {t('evaluations.expectedRoute')}
                          </FieldLabel>
                          <Select
                            value={draft.expectedRoute}
                            items={routesForNode.map((route) => ({
                              value: route.route,
                              label: route.label,
                            }))}
                            onValueChange={(expectedRoute) =>
                              setRouteDrafts((current) =>
                                current.map((item) =>
                                  item.id === draft.id && expectedRoute
                                    ? { ...item, expectedRoute }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={t(
                                  'evaluations.selectExpectedRoute',
                                )}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {routesForNode.map((route) => (
                                  <SelectItem
                                    key={route.route}
                                    value={route.route}
                                  >
                                    {route.label}
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
                          className='self-end'
                          aria-label={t('evaluations.deleteRouteAssertion', {
                            index: index + 1,
                          })}
                          onClick={() =>
                            setRouteDrafts((current) =>
                              current.filter((item) => item.id !== draft.id),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    );
                  })}
                  {!routeDrafts.length ? (
                    <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                      {t('evaluations.noRouteAssertions')}
                    </p>
                  ) : null}
                </FieldGroup>
              ) : (
                <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                  {t('evaluations.noRouteNodes')}
                </p>
              )}
            </FieldSet>

            <FieldSet className='rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>{t('evaluations.nodeTrajectory')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.nodeTrajectoryDescription')}
                  </FieldDescription>
                </div>
              </div>
              {configuredWorkflowNodes.length ? (
                <FieldGroup className='mt-4 gap-4'>
                  <div className='grid gap-4 lg:grid-cols-2'>
                    <Field className='bg-background rounded-lg border p-3'>
                      <div className='mb-3 flex items-center justify-between gap-3'>
                        <FieldLabel>
                          {t('evaluations.requiredNodes')}
                        </FieldLabel>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          onClick={() =>
                            setNodeTrajectory((current) => {
                              const node = configuredWorkflowNodes.find(
                                (candidate) =>
                                  !current.mustExecute.includes(candidate.id) &&
                                  !current.mustNotExecute.includes(
                                    candidate.id,
                                  ),
                              );
                              return node
                                ? {
                                    ...current,
                                    mustExecute: [
                                      ...current.mustExecute,
                                      node.id,
                                    ],
                                  }
                                : current;
                            })
                          }
                        >
                          <PlusIcon data-icon='inline-start' />{' '}
                          {t('evaluations.addNode')}
                        </Button>
                      </div>
                      <div className='flex flex-col gap-2'>
                        {nodeTrajectory.mustExecute.map((nodeId, index) => (
                          <div
                            key={`${nodeId}-${index}`}
                            className='flex items-center gap-2'
                          >
                            <Select
                              value={nodeId}
                              items={configuredWorkflowNodes.map((node) => ({
                                value: node.id,
                                label: node.label,
                              }))}
                              onValueChange={(value) =>
                                setNodeTrajectory((current) => ({
                                  ...current,
                                  mustExecute: current.mustExecute.map(
                                    (node, itemIndex) =>
                                      itemIndex === index
                                        ? (value ?? '')
                                        : node,
                                  ),
                                }))
                              }
                            >
                              <SelectTrigger className='min-w-0 flex-1'>
                                <SelectValue
                                  placeholder={t(
                                    'evaluations.selectWorkflowNode',
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {configuredWorkflowNodes.map((node) => (
                                    <SelectItem key={node.id} value={node.id}>
                                      {node.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              aria-label={t('evaluations.removeNode', {
                                index: index + 1,
                              })}
                              onClick={() =>
                                setNodeTrajectory((current) => ({
                                  ...current,
                                  mustExecute: current.mustExecute.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        ))}
                        {!nodeTrajectory.mustExecute.length ? (
                          <p className='text-muted-foreground text-sm'>
                            {t('evaluations.noRequiredNodes')}
                          </p>
                        ) : null}
                      </div>
                    </Field>
                    <Field className='bg-background rounded-lg border p-3'>
                      <div className='mb-3 flex items-center justify-between gap-3'>
                        <FieldLabel>
                          {t('evaluations.forbiddenNodes')}
                        </FieldLabel>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          onClick={() =>
                            setNodeTrajectory((current) => {
                              const node = configuredWorkflowNodes.find(
                                (candidate) =>
                                  !current.mustExecute.includes(candidate.id) &&
                                  !current.mustNotExecute.includes(
                                    candidate.id,
                                  ),
                              );
                              return node
                                ? {
                                    ...current,
                                    mustNotExecute: [
                                      ...current.mustNotExecute,
                                      node.id,
                                    ],
                                  }
                                : current;
                            })
                          }
                        >
                          <PlusIcon data-icon='inline-start' />{' '}
                          {t('evaluations.addNode')}
                        </Button>
                      </div>
                      <div className='flex flex-col gap-2'>
                        {nodeTrajectory.mustNotExecute.map((nodeId, index) => (
                          <div
                            key={`${nodeId}-${index}`}
                            className='flex items-center gap-2'
                          >
                            <Select
                              value={nodeId}
                              items={configuredWorkflowNodes.map((node) => ({
                                value: node.id,
                                label: node.label,
                              }))}
                              onValueChange={(value) =>
                                setNodeTrajectory((current) => ({
                                  ...current,
                                  mustNotExecute: current.mustNotExecute.map(
                                    (node, itemIndex) =>
                                      itemIndex === index
                                        ? (value ?? '')
                                        : node,
                                  ),
                                }))
                              }
                            >
                              <SelectTrigger className='min-w-0 flex-1'>
                                <SelectValue
                                  placeholder={t(
                                    'evaluations.selectWorkflowNode',
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {configuredWorkflowNodes.map((node) => (
                                    <SelectItem key={node.id} value={node.id}>
                                      {node.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              aria-label={t('evaluations.removeNode', {
                                index: index + 1,
                              })}
                              onClick={() =>
                                setNodeTrajectory((current) => ({
                                  ...current,
                                  mustNotExecute: current.mustNotExecute.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        ))}
                        {!nodeTrajectory.mustNotExecute.length ? (
                          <p className='text-muted-foreground text-sm'>
                            {t('evaluations.noForbiddenNodes')}
                          </p>
                        ) : null}
                      </div>
                    </Field>
                  </div>
                  <Field className='bg-background rounded-lg border p-3'>
                    <div className='mb-3 flex items-center justify-between gap-3'>
                      <div>
                        <FieldLabel>{t('evaluations.nodeOrder')}</FieldLabel>
                        <FieldDescription>
                          {t('evaluations.nodeOrderDescription')}
                        </FieldDescription>
                      </div>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() =>
                          setNodeTrajectory((current) => ({
                            ...current,
                            orderedNodes: [
                              ...current.orderedNodes,
                              configuredWorkflowNodes[0].id,
                            ],
                          }))
                        }
                      >
                        <PlusIcon data-icon='inline-start' />{' '}
                        {t('evaluations.addNode')}
                      </Button>
                    </div>
                    <div className='flex flex-col gap-2'>
                      {nodeTrajectory.orderedNodes.map((nodeId, index) => (
                        <div
                          key={`${nodeId}-${index}`}
                          className='flex items-center gap-2'
                        >
                          <span className='text-muted-foreground w-5 text-right text-sm'>
                            {index + 1}.
                          </span>
                          <Select
                            value={nodeId}
                            items={configuredWorkflowNodes.map((node) => ({
                              value: node.id,
                              label: node.label,
                            }))}
                            onValueChange={(value) =>
                              setNodeTrajectory((current) => ({
                                ...current,
                                orderedNodes: current.orderedNodes.map(
                                  (node, itemIndex) =>
                                    itemIndex === index ? (value ?? '') : node,
                                ),
                              }))
                            }
                          >
                            <SelectTrigger className='min-w-0 flex-1'>
                              <SelectValue
                                placeholder={t(
                                  'evaluations.selectWorkflowNode',
                                )}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {configuredWorkflowNodes.map((node) => (
                                  <SelectItem key={node.id} value={node.id}>
                                    {node.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-sm'
                            disabled={index === 0}
                            aria-label={t('evaluations.moveNodeUp', {
                              index: index + 1,
                            })}
                            onClick={() =>
                              setNodeTrajectory((current) => {
                                const orderedNodes = [...current.orderedNodes];
                                [orderedNodes[index - 1], orderedNodes[index]] =
                                  [
                                    orderedNodes[index],
                                    orderedNodes[index - 1],
                                  ];
                                return { ...current, orderedNodes };
                              })
                            }
                          >
                            <ArrowUpIcon />
                          </Button>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-sm'
                            disabled={
                              index === nodeTrajectory.orderedNodes.length - 1
                            }
                            aria-label={t('evaluations.moveNodeDown', {
                              index: index + 1,
                            })}
                            onClick={() =>
                              setNodeTrajectory((current) => {
                                const orderedNodes = [...current.orderedNodes];
                                [orderedNodes[index], orderedNodes[index + 1]] =
                                  [
                                    orderedNodes[index + 1],
                                    orderedNodes[index],
                                  ];
                                return { ...current, orderedNodes };
                              })
                            }
                          >
                            <ArrowDownIcon />
                          </Button>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('evaluations.removeNode', {
                              index: index + 1,
                            })}
                            onClick={() =>
                              setNodeTrajectory((current) => ({
                                ...current,
                                orderedNodes: current.orderedNodes.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              }))
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      ))}
                      {!nodeTrajectory.orderedNodes.length ? (
                        <p className='text-muted-foreground text-sm'>
                          {t('evaluations.noNodeOrder')}
                        </p>
                      ) : null}
                    </div>
                  </Field>
                  <Field orientation='horizontal'>
                    <Checkbox
                      id='evaluation-node-require-completed'
                      checked={nodeTrajectory.requireCompleted}
                      onCheckedChange={(checked) =>
                        setNodeTrajectory((current) => ({
                          ...current,
                          requireCompleted: checked === true,
                        }))
                      }
                    />
                    <Label htmlFor='evaluation-node-require-completed'>
                      {t('evaluations.requireNodeCompletion')}
                    </Label>
                  </Field>
                </FieldGroup>
              ) : (
                <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                  {t('evaluations.noWorkflowNodes')}
                </p>
              )}
            </FieldSet>

            <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>{t('evaluations.safetyAssertions')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.safetyAssertionsDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    setSafetyDrafts((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        target: 'final_output',
                        fieldPaths: '',
                        forbiddenText: '',
                      },
                    ])
                  }
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addSafetyRule')}
                </Button>
              </div>
              <FieldGroup className='mt-4 gap-3'>
                {safetyDrafts.map((rule, index) => (
                  <div
                    key={rule.id}
                    className='bg-background rounded-lg border p-3'
                  >
                    <div className='mb-3 flex items-center justify-between'>
                      <span className='text-sm font-medium'>
                        {t('evaluations.safetyRule', { index: index + 1 })}
                      </span>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon-sm'
                        aria-label={t('evaluations.deleteSafetyRule', {
                          index: index + 1,
                        })}
                        onClick={() =>
                          setSafetyDrafts((current) =>
                            current.filter((item) => item.id !== rule.id),
                          )
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <div className='grid gap-3 sm:grid-cols-2'>
                      <Field>
                        <FieldLabel>{t('evaluations.checkTarget')}</FieldLabel>
                        <Select
                          value={rule.target}
                          items={[
                            {
                              value: 'final_output',
                              label: t('evaluations.finalOutput'),
                            },
                            {
                              value: 'tool_arguments',
                              label: t('evaluations.toolArguments'),
                            },
                            {
                              value: 'tool_results',
                              label: t('evaluations.toolResults'),
                            },
                          ]}
                          onValueChange={(value) =>
                            setSafetyDrafts((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? { ...item, target: value as SafetyTarget }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value='final_output'>
                                {t('evaluations.finalOutput')}
                              </SelectItem>
                              <SelectItem value='tool_arguments'>
                                {t('evaluations.toolArguments')}
                              </SelectItem>
                              <SelectItem value='tool_results'>
                                {t('evaluations.toolResults')}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>
                          {t('evaluations.forbiddenFieldPaths')}
                        </FieldLabel>
                        <Textarea
                          className='min-h-20 font-mono text-xs leading-5'
                          placeholder='$.customer.email'
                          value={rule.fieldPaths}
                          onChange={(event) =>
                            setSafetyDrafts((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      fieldPaths: event.target.value,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field className='sm:col-span-2'>
                        <FieldLabel>
                          {t('evaluations.forbiddenText')}
                        </FieldLabel>
                        <Textarea
                          className='min-h-20'
                          placeholder='secret-token'
                          value={rule.forbiddenText}
                          onChange={(event) =>
                            setSafetyDrafts((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      forbiddenText: event.target.value,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </FieldGroup>
            </FieldSet>

            <FieldSet className='rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5'>
              <div className='flex items-start justify-between gap-3'>
                <div>
                  <FieldLegend>{t('evaluations.toolTrajectory')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.toolTrajectoryDescription')}
                  </FieldDescription>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    setToolTrajectory((current) => ({
                      ...current,
                      calls: [...current.calls, toolCallDraft()],
                    }))
                  }
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addCall')}
                </Button>
              </div>
              <FieldGroup className='mt-4 gap-3'>
                <div className='flex flex-wrap gap-x-5 gap-y-2'>
                  <Field orientation='horizontal'>
                    <Checkbox
                      id='evaluation-tool-strict-order'
                      checked={toolTrajectory.strictOrder}
                      onCheckedChange={(checked) =>
                        setToolTrajectory((current) => ({
                          ...current,
                          strictOrder: checked === true,
                        }))
                      }
                    />
                    <Label htmlFor='evaluation-tool-strict-order'>
                      {t('evaluations.strictOrder')}
                    </Label>
                  </Field>
                  <Field orientation='horizontal'>
                    <Checkbox
                      id='evaluation-tool-strict-args'
                      checked={toolTrajectory.strictArgs}
                      onCheckedChange={(checked) =>
                        setToolTrajectory((current) => ({
                          ...current,
                          strictArgs: checked === true,
                        }))
                      }
                    />
                    <Label htmlFor='evaluation-tool-strict-args'>
                      {t('evaluations.strictArgs')}
                    </Label>
                  </Field>
                </div>
                {toolTrajectory.calls.map((call, index) => (
                  <div
                    key={call.id}
                    className='bg-background rounded-lg border p-3'
                  >
                    <div className='mb-3 flex items-center justify-between'>
                      <span className='text-sm font-medium'>
                        {t('evaluations.expectedCall', { index: index + 1 })}
                      </span>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon-sm'
                        aria-label={t('evaluations.deleteExpectedCall', {
                          index: index + 1,
                        })}
                        onClick={() =>
                          setToolTrajectory((current) => ({
                            ...current,
                            calls: current.calls.filter(
                              (item) => item.id !== call.id,
                            ),
                          }))
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <div className='grid gap-3 sm:grid-cols-2'>
                      <Field>
                        <FieldLabel>{t('evaluations.tool')}</FieldLabel>
                        <Select
                          value={call.name}
                          onValueChange={(value) =>
                            setToolTrajectory((current) => ({
                              ...current,
                              calls: current.calls.map((item) =>
                                item.id === call.id
                                  ? { ...item, name: value ?? '' }
                                  : item,
                              ),
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t('evaluations.selectWorkflowTool')}
                            >
                              {call.name
                                ? selectedToolLabel(call.name, configuredTools)
                                : undefined}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {configuredTools.map((tool) => (
                                <SelectItem key={tool.id} value={tool.name}>
                                  {toolLabel(tool)}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.callCount')}</FieldLabel>
                        <Input
                          type='number'
                          min={1}
                          value={call.count}
                          onChange={(event) =>
                            setToolTrajectory((current) => ({
                              ...current,
                              calls: current.calls.map((item) =>
                                item.id === call.id
                                  ? {
                                      ...item,
                                      count: Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                      ),
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </Field>
                      <Field className='sm:col-span-2'>
                        <FieldLabel>{t('evaluations.expectedArgs')}</FieldLabel>
                        <Textarea
                          className='min-h-20 font-mono text-xs leading-5'
                          value={call.args}
                          onChange={(event) =>
                            setToolTrajectory((current) => ({
                              ...current,
                              calls: current.calls.map((item) =>
                                item.id === call.id
                                  ? { ...item, args: event.target.value }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </Field>
                      <Field orientation='horizontal' className='sm:col-span-2'>
                        <Checkbox
                          id={`evaluation-tool-result-${call.id}`}
                          checked={call.assertResult}
                          onCheckedChange={(checked) =>
                            setToolTrajectory((current) => ({
                              ...current,
                              calls: current.calls.map((item) =>
                                item.id === call.id
                                  ? {
                                      ...item,
                                      assertResult: checked === true,
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                        <Label htmlFor={`evaluation-tool-result-${call.id}`}>
                          {t('evaluations.assertToolResult')}
                        </Label>
                      </Field>
                      {call.assertResult ? (
                        <Field className='sm:col-span-2'>
                          <FieldLabel>
                            {t('evaluations.expectedFixtureResult')}
                          </FieldLabel>
                          <Textarea
                            className='min-h-20 font-mono text-xs leading-5'
                            value={call.expectedResult}
                            onChange={(event) =>
                              setToolTrajectory((current) => ({
                                ...current,
                                calls: current.calls.map((item) =>
                                  item.id === call.id
                                    ? {
                                        ...item,
                                        expectedResult: event.target.value,
                                      }
                                    : item,
                                ),
                              }))
                            }
                          />
                        </Field>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!toolTrajectory.calls.length ? (
                  <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-5 text-center text-sm'>
                    {t('evaluations.noExpectedCalls')}
                  </p>
                ) : null}
              </FieldGroup>
            </FieldSet>

            <FieldSet className='rounded-xl border border-dashed p-4 sm:p-5'>
              <FieldLegend>{t('evaluations.advancedAssertions')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.advancedAssertionsDescription')}
              </FieldDescription>
              <Field>
                <FieldLabel htmlFor='evaluation-case-assertions'>
                  {t('evaluations.assertionsJson')}
                </FieldLabel>
                <Textarea
                  id='evaluation-case-assertions'
                  className='min-h-36 font-mono text-xs leading-5'
                  placeholder={
                    '[\n  {\n    "kind": "json_path",\n    "id": "decision-is-approved",\n    "path": "$.decision",\n    "operator": "equals",\n    "expected": "approved"\n  }\n]'
                  }
                  value={assertionsJson}
                  readOnly
                />
              </Field>
            </FieldSet>

            <FieldSet>
              <FieldLegend>{t('evaluations.toolFixtures')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.toolFixturesDescription')}
              </FieldDescription>
              <FieldGroup className='mt-4 gap-3'>
                {fixtureDrafts.map((fixture, index) => (
                  <div
                    key={fixture.id}
                    className='bg-card rounded-xl border p-4 shadow-sm'
                  >
                    <div className='mb-4 flex items-center justify-between'>
                      <span className='text-sm font-medium'>
                        {t('evaluations.fixture', { index: index + 1 })}
                      </span>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon-sm'
                        aria-label={t('evaluations.deleteFixture', {
                          index: index + 1,
                        })}
                        onClick={() =>
                          setFixtureDrafts((current) =>
                            current.filter((item) => item.id !== fixture.id),
                          )
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <div className='grid gap-4 md:grid-cols-2'>
                      <Field>
                        <FieldLabel>{t('evaluations.fixtureNode')}</FieldLabel>
                        <Select
                          value={fixture.nodeId || '__global__'}
                          items={[
                            {
                              value: '__global__',
                              label: t('evaluations.fixtureAnyNode'),
                            },
                            ...configuredAgentNodes.map((node) => ({
                              value: node.id,
                              label: node.label,
                            })),
                          ]}
                          onValueChange={(value) =>
                            setFixtureDrafts((current) =>
                              current.map((item) =>
                                item.id === fixture.id
                                  ? {
                                      ...item,
                                      nodeId:
                                        value === '__global__'
                                          ? ''
                                          : (value ?? ''),
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value='__global__'>
                                {t('evaluations.fixtureAnyNode')}
                              </SelectItem>
                              {configuredAgentNodes.map((node) => (
                                <SelectItem key={node.id} value={node.id}>
                                  {node.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.tool')}</FieldLabel>
                        <Select
                          value={fixture.tool}
                          onValueChange={(value) =>
                            setFixtureDrafts((current) =>
                              current.map((item) =>
                                item.id === fixture.id
                                  ? { ...item, tool: value ?? '' }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t('evaluations.selectWorkflowTool')}
                            >
                              {fixture.tool
                                ? selectedToolLabel(
                                    fixture.tool,
                                    configuredTools,
                                  )
                                : undefined}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {configuredTools.map((tool) => (
                                <SelectItem key={tool.id} value={tool.name}>
                                  {toolLabel(tool)}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>
                          {t('evaluations.matchingArgsJson')}
                        </FieldLabel>
                        <Textarea
                          className='min-h-20 font-mono text-xs leading-5'
                          value={fixture.args}
                          onChange={(event) =>
                            setFixtureDrafts((current) =>
                              current.map((item) =>
                                item.id === fixture.id
                                  ? { ...item, args: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>
                          {t('evaluations.fixtureResultJson')}
                        </FieldLabel>
                        <Textarea
                          className='min-h-20 font-mono text-xs leading-5'
                          value={fixture.result}
                          onChange={(event) =>
                            setFixtureDrafts((current) =>
                              current.map((item) =>
                                item.id === fixture.id
                                  ? { ...item, result: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                    </div>
                  </div>
                ))}
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    setFixtureDrafts((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        nodeId: '',
                        tool: '',
                        args: '{}',
                        result: '{}',
                      },
                    ])
                  }
                >
                  <PlusIcon data-icon='inline-start' />{' '}
                  {t('evaluations.addFixture')}
                </Button>
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </div>
        <DialogFooter className='mx-0 mb-0'>
          <Button variant='outline' onClick={() => setCaseDialogOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={
              !caseName.trim() ||
              (!assertionDrafts.length &&
                !toolTrajectory.calls.length &&
                !nodeTrajectory.mustExecute.length &&
                !nodeTrajectory.mustNotExecute.length &&
                !nodeTrajectory.orderedNodes.length &&
                !routeDrafts.length &&
                !nodeOutputDrafts.length &&
                !nodeTextDrafts.length &&
                !nodeToolDrafts.length) ||
              saving
            }
            onClick={() => void saveCase()}
          >
            {saving ? <Spinner /> : null}{' '}
            {editingCase
              ? t('evaluations.saveChanges')
              : t('evaluations.saveCase')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
