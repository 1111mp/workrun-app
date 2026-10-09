import { invoke } from '@tauri-apps/api/core';

import type { ProcessNode, ProcessNodeDefinition } from './process-node';

export type AppShareFormat = 'zip' | 'tar';
export type AppSharePreview = {
  manifest: {
    format: 'workrun-app';
    formatVersion: number;
    exportedAt: string;
    workrunVersion: string;
    sourceDirectory: string;
  };
  app: Pick<
    ProcessNodeDefinition,
    | 'name'
    | 'description'
    | 'version'
    | 'kind'
    | 'entry'
    | 'compensation'
    | 'inputs'
    | 'outputs'
    | 'toolExecutionPolicy'
    | 'toolRiskLevel'
    | 'toolPermissions'
  >;
  files: string[];
  totalBytes: number;
  sha256: string | null;
};

export function previewAppExport(id: string) {
  return invoke<AppSharePreview>('app_share_export_preview', { id });
}

export function exportApp(
  id: string,
  destination: string,
  format: AppShareFormat,
  excludedFiles: string[],
  expectedFiles: string[],
) {
  return invoke<void>('app_share_export', {
    id,
    destination,
    format,
    excludedFiles,
    expectedFiles,
  });
}

export function previewAppImport(path: string) {
  return invoke<AppSharePreview>('app_share_import_preview', { path });
}

export function importApp(path: string, sha256: string, name: string) {
  return invoke<ProcessNode>('app_share_import', { path, sha256, name });
}
