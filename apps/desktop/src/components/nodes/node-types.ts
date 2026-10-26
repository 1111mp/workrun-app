import type { NodeTypes } from '@xyflow/react';

import { AgentNode } from './agent-node';
import { AskUserQuestionNode } from './ask-user-question-node';
import { CodeActAgentNode } from './codeact-agent-node';
import { EndNode } from './end-node';
import { GroupNode } from './group-node';
import { HumanReviewNode } from './human-review-node';
import { IfElseNode } from './if-else-node';
import { ProcessNode } from './process-node';
import { RemoteAgentNode } from './remote-agent-node';
import { StartNode } from './start-node';
import { SubworkflowNode } from './subworkflow-node';
import { SwitchNode } from './switch-node';
import { TerminateNode } from './terminate-node';

/** The editor and read-only comparisons share the same node renderers. */
export const workflowNodeTypes = {
  agent: AgentNode,
  codeact_agent: CodeActAgentNode,
  remote_agent: RemoteAgentNode,
  process: ProcessNode,
  start: StartNode,
  end: EndNode,
  if_else: IfElseNode,
  switch: SwitchNode,
  group: GroupNode,
  human_review: HumanReviewNode,
  ask_user_question: AskUserQuestionNode,
  subworkflow: SubworkflowNode,
  terminate: TerminateNode,
} satisfies NodeTypes;
