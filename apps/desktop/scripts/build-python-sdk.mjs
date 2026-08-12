import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sdkProject = fileURLToPath(
  new URL('../../../packages/python-sdk/', import.meta.url),
);
const wheelDirectory = fileURLToPath(
  new URL('../src-tauri/resources/python-wheels/', import.meta.url),
);
const uv = process.env.UV ?? 'uv';

// Wheels are generated for every Desktop build so the resource directory never
// contains a stale SDK version from an earlier build.
await rm(wheelDirectory, { recursive: true, force: true });
await mkdir(wheelDirectory, { recursive: true });

const result = spawnSync(
  uv,
  ['build', sdkProject, '--wheel', '--out-dir', wheelDirectory],
  { stdio: 'inherit' },
);

if (result.error) {
  throw new Error(`Unable to run ${uv} to build the Workrun Python SDK`, {
    cause: result.error,
  });
}
if (result.status !== 0) {
  throw new Error(`Building the Workrun Python SDK failed with exit code ${result.status}`);
}
