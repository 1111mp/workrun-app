import { invoke } from '@tauri-apps/api/core';

export type SkillSummary = {
  name: string;
  description: string;
  version?: string;
  license?: string;
  allowedTools: string[];
  compatibility?: string;
  tags: string[];
  references: string[];
  trigger: boolean;
  hint?: string;
  metadata: Record<string, unknown>;
};

type AdkSkillSummary = {
  name: string;
  description: string;
  version?: string;
  license?: string;
  allowed_tools: string[];
  compatibility?: string;
  tags: string[];
  references: string[];
  trigger: boolean;
  hint?: string;
  metadata: Record<string, unknown>;
};

type AdkSkillDocument = AdkSkillSummary & { body: string };

export type SkillDetails = SkillSummary & { instructions: string };

export type SkillWriteRequest = {
  name: string;
  description: string;
  version?: string;
  license?: string;
  compatibility?: string;
  tags?: string;
  allowedTools?: string;
  references?: string;
  trigger?: boolean;
  hint?: string;
  metadata?: string;
  instructions?: string;
};

export function listSkills() {
  return invoke<AdkSkillSummary[]>('skill_list').then((skills) =>
    skills.map(toSkillSummary),
  );
}

export function inspectSkill(name: string) {
  return invoke<AdkSkillDocument>('skill_inspect', { name }).then(
    toSkillDetails,
  );
}

export function createSkill(request: SkillWriteRequest) {
  return invoke<AdkSkillDocument>('skill_create', {
    request: toAdkSkillWriteRequest(request),
  }).then(toSkillDetails);
}

export function updateSkill(request: SkillWriteRequest) {
  return invoke<AdkSkillDocument>('skill_update', {
    request: toAdkSkillWriteRequest(request),
  }).then(toSkillDetails);
}

export function deleteSkill(name: string) {
  return invoke('skill_delete', { name });
}

export function openSkillDirectory() {
  return invoke('skill_open_directory');
}

export function openSkillFolder(name: string) {
  return invoke('skill_open_folder', { name });
}

function toSkillSummary(skill: AdkSkillSummary): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    license: skill.license,
    allowedTools: skill.allowed_tools,
    compatibility: skill.compatibility,
    tags: skill.tags,
    references: skill.references,
    trigger: skill.trigger,
    hint: skill.hint,
    metadata: skill.metadata,
  };
}

function toSkillDetails(skill: AdkSkillDocument): SkillDetails {
  return { ...toSkillSummary(skill), instructions: skill.body };
}

function toAdkSkillWriteRequest(request: SkillWriteRequest) {
  const { metadata, ...skill } = request;
  return {
    ...skill,
    metadata: metadata?.trim()
      ? (JSON.parse(metadata) as Record<string, unknown>)
      : {},
  };
}
