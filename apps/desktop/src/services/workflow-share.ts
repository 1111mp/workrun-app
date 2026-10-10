import { invoke } from '@tauri-apps/api/core';

import type { AppShareFormat } from './app-share';
import type { ToolDefinition } from './tool';
import type { StoredWorkflow } from './workflow';

export type ShareDependency = { id: string; name: string };
export type WorkflowShareRequirement = {
  id: string;
  kind:
    | 'model'
    | 'tool'
    | 'skill'
    | 'credential'
    | 'mount'
    | 'environment'
    | 'url';
  label: string;
  suggestedValue?: string;
  origin?: string;
  credentialKind?: 'bearer' | 'apiKey';
};
export type WorkflowSharePreview = {
  manifest: {
    format: 'workrun-workflow';
    formatVersion: number;
    exportedAt: string;
    workrunVersion: string;
    entryWorkflowId: string;
    workflows: ShareDependency[];
    apps: ShareDependency[];
    requirements: WorkflowShareRequirement[];
  };
  files: string[];
  totalBytes: number;
  fingerprint: string;
  bindings: Record<string, string>;
};
export type WorkflowShareImportResult = {
  workflow: StoredWorkflow;
  apps: ShareDependency[];
  pending: WorkflowShareRequirement[];
};

export function previewWorkflowExport(id: string) {
  return invoke<WorkflowSharePreview>('workflow_share_export_preview', { id });
}
export function listWorkflowShareMcpTools() {
  return invoke<ToolDefinition[]>('workflow_share_mcp_tools');
}
export function exportWorkflow(
  id: string,
  destination: string,
  format: AppShareFormat,
  fingerprint: string,
) {
  return invoke<void>('workflow_share_export', {
    id,
    destination,
    format,
    fingerprint,
  });
}
export function previewWorkflowImport(path: string) {
  return invoke<WorkflowSharePreview>('workflow_share_import_preview', {
    path,
  });
}
export function importWorkflow(
  path: string,
  fingerprint: string,
  name: string,
  bindings: Record<string, string>,
) {
  return invoke<WorkflowShareImportResult>('workflow_share_import', {
    path,
    fingerprint,
    name,
    bindings,
  });
}

export function previewWorkflowConfiguration(id: string) {
  return invoke<WorkflowSharePreview>('workflow_share_configuration_preview', {
    id,
  });
}

export function configureImportedWorkflow(
  id: string,
  fingerprint: string,
  bindings: Record<string, string>,
) {
  return invoke<StoredWorkflow>('workflow_share_configure', {
    id,
    fingerprint,
    bindings,
  });
}
