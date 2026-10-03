/**
 * @filename: .lintstagedrc.js
 * @type {import('lint-staged').Configuration}
 */
const oxfmtFiles = (filenames) => {
  // `src-tauri` intentionally contains generated platform assets which oxfmt
  // ignores. Avoid invoking it when every staged match belongs there.
  const formattableFiles = filenames.filter(
    (filename) => !filename.includes('/apps/desktop/src-tauri/'),
  );

  return formattableFiles.length === 0
    ? []
    : `oxfmt --write ${formattableFiles.map(JSON.stringify).join(' ')}`;
};

export default {
  '**/*.{js,mjs,cjs,ts,jsx,tsx}': [oxfmtFiles, 'oxlint --type-aware'],
  '**/*.{json,md,html,css}': [oxfmtFiles],
};
