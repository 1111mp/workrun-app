import fsp from 'fs/promises';
import { fileURLToPath } from 'url';

import fs from 'fs-extra';

const UPDATE_LOG = 'UPDATELOG.md';
// Keep the log at the repository root even when pnpm runs this package script
// with apps/desktop as its working directory.
const UPDATE_LOG_PATH = fileURLToPath(
  new URL(`../../../${UPDATE_LOG}`, import.meta.url),
);

// parse the UPDATELOG.md
export async function resolveUpdateLog(tag) {
  const reTitle = /^## v[\d.]+/;
  const reEnd = /^---/;

  const file = UPDATE_LOG_PATH;

  if (!(await fs.pathExists(file))) {
    throw new Error('could not found UPDATELOG.md');
  }

  const data = await fsp.readFile(file, 'utf-8');

  const map = {};
  let p = '';

  data.split('\n').forEach((line) => {
    if (reTitle.test(line)) {
      p = line.slice(3).trim();
      if (!map[p]) {
        map[p] = [];
      } else {
        throw new Error(`Tag ${p} dup`);
      }
    } else if (reEnd.test(line)) {
      p = '';
    } else if (p) {
      map[p].push(line);
    }
  });

  if (!map[tag]) {
    throw new Error(`could not found "${tag}" in UPDATELOG.md`);
  }

  return map[tag].join('\n').trim();
}

export async function resolveUpdateLogDefault() {
  const file = UPDATE_LOG_PATH;

  if (!(await fs.pathExists(file))) {
    throw new Error('could not found UPDATELOG.md');
  }

  const data = await fsp.readFile(file, 'utf-8');

  const reTitle = /^## v[\d.]+/;
  const reEnd = /^---/;

  let isCapturing = false;
  const content = [];
  let firstTag = '';

  for (const line of data.split('\n')) {
    if (reTitle.test(line) && !isCapturing) {
      isCapturing = true;
      firstTag = line.slice(3).trim();
      continue;
    }

    if (isCapturing) {
      if (reEnd.test(line)) {
        break;
      }
      content.push(line);
    }
  }

  if (!firstTag) {
    throw new Error('could not found any version tag in UPDATELOG.md');
  }

  return content.join('\n').trim();
}
