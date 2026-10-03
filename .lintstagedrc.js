/**
 * @filename: .lintstagedrc.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  '**/*.{js,mjs,cjs,ts,jsx,tsx}': ['oxfmt --write', 'oxlint --type-aware'],
  '**/*.{json,md,html,css}': ['oxfmt --write'],
};
