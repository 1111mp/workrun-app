import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binaryName = process.platform === 'win32' ? 'workrun.exe' : 'workrun';
const bundleName = 'Workrun E2E.app';
const binary =
  process.platform === 'darwin'
    ? join(root, 'target/e2e', bundleName, 'Contents/MacOS', binaryName)
    : join(root, 'target/e2e', binaryName);

async function run(args, env = {}) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  if (code !== 0) process.exit(code);
}

if (process.argv[2] === 'build') {
  await run(
    [
      'exec',
      'tauri',
      'build',
      '--debug',
      ...(process.platform === 'darwin'
        ? ['--bundles', 'app']
        : ['--no-bundle']),
      '--features',
      'e2e',
      '--config',
      'src-tauri/tauri.e2e.conf.json',
    ],
    { CARGO_TARGET_DIR: join(root, 'target') },
  );
  // Reuse Cargo's existing cache, but launch only the explicitly built test binary.
  await mkdir(join(root, 'target/e2e'), { recursive: true });
  if (process.platform === 'darwin') {
    // NSBundle resource lookup requires a real .app layout on macOS.
    await cp(
      join(root, 'target/debug/bundle/macos', bundleName),
      join(root, 'target/e2e', bundleName),
      { recursive: true },
    );
  } else {
    await copyFile(join(root, 'target/debug', binaryName), binary);
    for (const resource of [
      'resources',
      'icons',
      process.platform === 'win32' ? 'uv.exe' : 'uv',
    ]) {
      await cp(
        join(root, 'target/debug', resource),
        join(root, 'target/e2e', resource),
        { recursive: true },
      );
    }
  }
} else {
  const dataDir = await mkdtemp(join(tmpdir(), 'workrun-e2e-'));
  // Seed an empty personal workspace so native IPC can start before onboarding completes.
  for (const [relativePath, catalog] of [
    ['personal/workflow.json', { workflows: [] }],
    ['personal/process-nodes/catalog.json', { nodes: [] }],
    ['personal/mcp-servers/catalog.json', { servers: [] }],
  ]) {
    const path = join(dataDir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(catalog));
  }
  await writeFile(
    join(dataDir, 'workrun.yaml'),
    JSON.stringify({
      locale: 'en',
      theme: 'light',
      onboarding_completed: false,
      workspace_mode: 'personal',
      enable_auto_launch: false,
      auto_check_update: false,
    }),
  );
  console.log(`E2E data and backend logs: ${dataDir}`);
  // Keep failed runs inspectable; this directory never contains personal data.
  await run(['exec', 'wdio', 'run', 'wdio.conf.ts', ...process.argv.slice(2)], {
    WORKRUN_E2E_DATA_DIR: dataDir,
    WORKRUN_E2E_BINARY: binary,
  });
}
