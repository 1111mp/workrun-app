import { invoke } from '@tauri-apps/api/core';

import type {
  ToolExecutionPolicy,
  ToolRiskLevel,
} from '@/services/process-node';

export type ToolSource = 'process' | 'mcp';

/** A Tool that can be selected by an Agent, regardless of its publisher. */
export type ToolDefinition = {
  id: string;
  source: ToolSource;
  sourceId?: string;
  sourceName?: string;
  displayName: string;
  name: string;
  description: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  permissions: string[];
  executionPolicy: ToolExecutionPolicy;
};

export function listTools() {
  return invoke<ToolDefinition[]>('tool_list');
}
