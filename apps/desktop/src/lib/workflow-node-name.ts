import type { Node } from '@xyflow/react';

/** Repair previously persisted label mistakes; label is not part of the Agent contract. */
export function normalizeWorkflowNodeName<T extends Node>(node: T): T {
  if (
    !['agent', 'codeact_agent'].includes(node.type ?? '') ||
    !Object.hasOwn(node.data, 'label')
  )
    return node;
  const { label, ...data } = node.data;
  const name =
    typeof data.name === 'string' && data.name.trim()
      ? data.name
      : typeof label === 'string'
        ? label
        : typeof data.name === 'string'
          ? data.name
          : '';
  return { ...node, data: { ...data, name } };
}
