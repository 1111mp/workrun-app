import { invoke } from '@tauri-apps/api/core';

export function getUvVersion() {
  return invoke<string>('uv_version');
}

export interface ManagedPython {
  requestedVersion: string;
  executablePath: string;
  version: string;
}

/** Install (if required) and resolve a Python interpreter owned by Workrun. */
export function ensurePython(version = '3.12') {
  return invoke<ManagedPython>('ensure_python', { version });
}

export interface ManagedVenv {
  projectPath: string;
  environmentPath: string;
  executablePath: string;
  python: ManagedPython;
}

/** Create or reuse `.venv` in a project with a Workrun-managed Python. */
export function ensureVenv(projectPath: string, version = '3.12') {
  return invoke<ManagedVenv>('ensure_venv', { projectPath, version });
}

export interface DependencySyncResult {
  environment: ManagedVenv;
  lockfilePath: string;
  usedExistingLockfile: boolean;
}

/** Synchronize a uv project's locked dependencies into its local `.venv`. */
export function syncDependencies(projectPath: string, version = '3.12') {
  return invoke<DependencySyncResult>('sync_dependencies', {
    projectPath,
    version,
  });
}

export interface PythonExecutionResult {
  scriptPath: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProjectPythonRunResult {
  sync: DependencySyncResult;
  execution: PythonExecutionResult;
}

export interface RunProjectPythonRequest {
  projectPath: string;
  scriptPath: string;
  pythonVersion?: string;
  args?: string[];
}

/** Prepare a uv project, sync dependencies, then run one Python script. */
export function runProjectPython(request: RunProjectPythonRequest) {
  return invoke<ProjectPythonRunResult>('run_project_python', { request });
}
