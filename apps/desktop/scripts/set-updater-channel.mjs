import fs from 'fs-extra';

const version = process.env.GITHUB_REF_NAME ?? '';

async function resolveChannel() {
  if (!version) throw new Error('GITHUB_REF_NAME not set');

  console.log(`Release tag: ${version}`);

  const preReleaseRegex = /^v\d+\.\d+\.\d+-(alpha|beta|rc|pre)/i; // Matches vX.Y.Z-alpha/beta/rc format
  const isPreRelease = preReleaseRegex.test(version);

  console.log(`Channel: ${isPreRelease ? 'alpha' : 'release'}`);

  if (!isPreRelease) {
    console.log('Release channel detected, skipping updater endpoint change.');
    return;
  }

  const config = await fs.readJSON('src-tauri/tauri.conf.json');

  config.plugins.updater.endpoints = [
    'https://github.com/1111mp/workrun-app/releases/download/updater-alpha/update.json',
  ];

  console.log('config', config);
  console.log(
    'config.plugins.updater.endpoints',
    config.plugins.updater.endpoints,
  );

  await fs.writeJSON('src-tauri/tauri.conf.json', config, { spaces: 2 });

  console.log('Updated updater endpoint to alpha channel.');
}

resolveChannel().catch(console.error);
