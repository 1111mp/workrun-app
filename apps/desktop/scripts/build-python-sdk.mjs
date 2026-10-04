import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sdkProject = fileURLToPath(
  new URL('../../../packages/python-sdk/', import.meta.url),
);
const wheelDirectory = fileURLToPath(
  new URL('../src-tauri/resources/python-wheels/', import.meta.url),
);
function rustHostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = output.match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Unable to determine Rust host target triple');
  return host;
}

const bundledUv = fileURLToPath(
  new URL(
    `../src-tauri/binaries/uv-${rustHostTriple()}${
      process.platform === 'win32' ? '.exe' : ''
    }`,
    import.meta.url,
  ),
);
// prebuild downloads this sidecar but intentionally does not add it to PATH.
// Building with it keeps local builds independent of a system-wide uv install.
const uv = process.env.UV ?? bundledUv;

if (!process.env.UV && !existsSync(bundledUv)) {
  throw new Error(`Bundled uv sidecar is missing: ${bundledUv}`);
}

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
  throw new Error(
    `Building the Workrun Python SDK failed with exit code ${result.status}`,
  );
}
