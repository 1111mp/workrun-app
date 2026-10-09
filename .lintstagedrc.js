/**
 * @filename: .lintstagedrc.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  // Staged files may all be excluded by a workspace's Oxlint ignore patterns.
  '**/*.{js,mjs,cjs,ts,jsx,tsx}': [
    'oxfmt --write --no-error-on-unmatched-pattern',
    'oxlint --type-aware --no-error-on-unmatched-pattern',
  ],
  '**/*.{md,html,css}': ['oxfmt --write --no-error-on-unmatched-pattern'],
};
