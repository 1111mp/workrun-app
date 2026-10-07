import { invoke } from '@tauri-apps/api/core';

export type ArtifactRef = {
  $type: 'artifact';
  id: string;
  version: number;
  name: string;
  mimeType: string;
  size: number;
};

export function artifactReferences(value: unknown): ArtifactRef[] {
  const found = new Map<string, ArtifactRef>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (
      '$type' in value &&
      value.$type === 'artifact' &&
      'id' in value &&
      typeof value.id === 'string'
    ) {
      const reference = value as ArtifactRef;
      if (
        reference.version !== 1 ||
        typeof reference.name !== 'string' ||
        typeof reference.mimeType !== 'string' ||
        typeof reference.size !== 'number' ||
        reference.size < 0
      )
        return;
      found.set(`${reference.id}:${reference.version}`, reference);
      return;
    }
    Object.values(value).forEach(visit);
  }
  visit(value);
  return [...found.values()];
}

export function pickArtifacts(multiple: boolean) {
  return invoke<ArtifactRef[]>('artifact_pick', { multiple });
}

export function exportArtifact(reference: ArtifactRef) {
  return invoke<boolean>('artifact_export', { reference });
}

export function previewArtifact(reference: ArtifactRef) {
  return invoke<string>('artifact_preview', { reference });
}

export function openPdfArtifact(reference: ArtifactRef) {
  return invoke<void>('artifact_open_pdf', { reference });
}
