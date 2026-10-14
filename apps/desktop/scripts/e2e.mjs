import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { access, copyFile, cp, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkspace } from './e2e-fixtures.mjs';

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
  const args = process.argv.slice(2);
  const patterns = [];
  const forwarded = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--spec') {
      if (!args[index + 1]) throw new Error('--spec requires a file or glob');
      patterns.push(args[++index]);
    } else if (arg.startsWith('--spec=')) {
      patterns.push(arg.slice('--spec='.length));
    } else {
      forwarded.push(arg);
    }
  }
  const specs = [
    ...new Set(
      globSync(patterns.length ? patterns : ['test/e2e/**/*.spec.ts'], {
        cwd: root,
      }),
    ),
  ].sort();
  if (!specs.length) throw new Error('No E2E specs matched');
  for (const spec of specs) {
    const workflow = basename(spec) === 'workflow.spec.ts';
    const dataDir = await createWorkspace(root, workflow);
    console.log(`E2E data and backend logs (${spec}): ${dataDir}`);
    const env = {
      WORKRUN_E2E_DATA_DIR: dataDir,
      WORKRUN_E2E_BINARY: binary,
      WORKRUN_E2E_RESTORE: '',
    };
    const command = [
      'exec',
      'wdio',
      'run',
      'wdio.conf.ts',
      ...forwarded,
      '--spec',
      spec,
    ];
    // Each spec gets its own native process and data; failed workspaces remain inspectable.
    await run(command, env);
    if (workflow) {
      await access(join(dataDir, 'workflow-run.json'));
      // A new WDIO invocation tears down and relaunches the native application.
      // Preserve its workspace to verify SQLite/catalog persistence across process lifetimes.
      await run(command, { ...env, WORKRUN_E2E_RESTORE: '1' });
    }
  }
}
