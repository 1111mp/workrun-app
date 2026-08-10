import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract as extractTar } from 'tar';

// Deliberately pin uv: it is shipped in every Workrun application bundle.
// Update this value in a dedicated dependency-update change, then let this
// script fetch and verify the corresponding official release artifact.
const UV_VERSION = '0.12.3';
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const BINARIES_DIR = fileURLToPath(
  new URL('../src-tauri/binaries/', import.meta.url),
);
const FORCE = process.argv.includes('--force') || process.argv.includes('-f');
const targetArg = process.argv
  .slice(2)
  .find((arg) => arg !== '--' && arg !== '--force' && arg !== '-f');

// Target triples are deliberately the same identifiers used by Tauri's
// `externalBin` convention. Pass one explicitly when cross-compiling:
//   pnpm prebuild -- x86_64-pc-windows-msvc
const TARGETS = {
  'aarch64-apple-darwin': { platform: 'darwin', archive: 'tar.gz' },
  'x86_64-apple-darwin': { platform: 'darwin', archive: 'tar.gz' },
  'aarch64-pc-windows-msvc': { platform: 'win32', archive: 'zip' },
  'i686-pc-windows-msvc': { platform: 'win32', archive: 'zip' },
  'x86_64-pc-windows-msvc': { platform: 'win32', archive: 'zip' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', archive: 'tar.gz' },
  'i686-unknown-linux-gnu': { platform: 'linux', archive: 'tar.gz' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', archive: 'tar.gz' },
};

function rustHostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = output.match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Unable to determine Rust host target triple');
  return host;
}

function resolveTarget() {
  // TAURI_ENV_TARGET_TRIPLE is provided by Tauri for target-aware builds;
  // WORKRUN_TAURI_TARGET also permits callers and CI to set it explicitly.
  const triple =
    targetArg ??
    process.env.WORKRUN_TAURI_TARGET ??
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    rustHostTriple();
  const target = TARGETS[triple];
  if (!target) throw new Error(`Unsupported uv sidecar target: ${triple}`);
  return { triple, ...target };
}

async function download(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'workrun-prebuild' },
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function extractArchive(archivePath, destination, archiveType) {
  if (archiveType !== 'tar.gz') {
    throw new Error(`Unsupported archive type: ${archiveType}`);
  }

  try {
    await extractTar({
      file: archivePath,
      cwd: destination,
      gzip: true,
    });
  } catch (error) {
    throw new Error(`Unable to extract ${basename(archivePath)}: ${error}`);
  }
}

async function findUvBinary(root, fileName) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return path;
    if (entry.isDirectory()) {
      const found = await findUvBinary(path, fileName);
      if (found) return found;
    }
  }
  return undefined;
}

function bundledVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const { triple, platform, archive: archiveType } = resolveTarget();
const extension = platform === 'win32' ? '.exe' : '';
const sidecarName = `uv-${triple}${extension}`;
const sidecarPath = join(BINARIES_DIR, sidecarName);
const currentVersion = bundledVersion(sidecarPath);

if (!FORCE && currentVersion?.startsWith(`uv ${UV_VERSION}`)) {
  console.log(`uv sidecar is ready: ${currentVersion}`);
  process.exit(0);
}

const archiveName = `uv-${triple}.${archiveType}`;
const archiveUrl = `${RELEASE_BASE}/${archiveName}`;
console.log(
  `Downloading uv ${UV_VERSION} for ${triple}${FORCE ? ' (forced)' : ''}…`,
);

const tempDir = await mkdtemp(join(tmpdir(), 'workrun-uv-'));
try {
  const [archive, checksumFile] = await Promise.all([
    download(archiveUrl),
    download(`${archiveUrl}.sha256`),
  ]);
  const expectedHash = checksumFile
    .toString('utf8')
    .match(/[a-f0-9]{64}/i)?.[0]
    ?.toLowerCase();
  const actualHash = createHash('sha256').update(archive).digest('hex');
  if (!expectedHash || actualHash !== expectedHash) {
    throw new Error(`Checksum verification failed for ${archiveName}`);
  }

  const archivePath = join(tempDir, archiveName);
  const extractDir = join(tempDir, 'extract');
  await writeFile(archivePath, archive);
  await mkdir(extractDir);
  await extractArchive(archivePath, extractDir, archiveType);

  const sourceBinary = await findUvBinary(extractDir, `uv${extension}`);
  if (!sourceBinary)
    throw new Error(`The uv archive did not contain uv${extension}`);

  await mkdir(BINARIES_DIR, { recursive: true });
  const stagedPath = join(tempDir, sidecarName);
  await writeFile(stagedPath, await readFile(sourceBinary), { mode: 0o755 });
  await rm(sidecarPath, { force: true });
  await rename(stagedPath, sidecarPath);

  const version = bundledVersion(sidecarPath);
  if (!version?.startsWith(`uv ${UV_VERSION}`)) {
    throw new Error(`Downloaded sidecar did not report uv ${UV_VERSION}`);
  }
  console.log(`uv sidecar installed: ${version}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
