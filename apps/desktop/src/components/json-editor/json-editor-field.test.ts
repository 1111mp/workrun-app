import { describe, expect, it } from 'vitest';

import { parseJsonContainer } from './json-editor-field';

describe('parseJsonContainer', () => {
  it('keeps optional JSON fields empty until the user creates a value', () => {
    expect(parseJsonContainer('   ', 'object')).toBeUndefined();
  });

  it('accepts a JSON object for object-backed Workrun fields', () => {
    expect(parseJsonContainer('{"owner":"platform"}', 'object')).toEqual({
      owner: 'platform',
    });
  });

  it('rejects an array when the saved field requires an object root', () => {
    expect(() => parseJsonContainer('[]', 'object')).toThrow('invalid root');
  });

  it('rejects malformed JSON so the caller can show CodeMirror recovery', () => {
    expect(() => parseJsonContainer('{"owner":', 'object')).toThrow();
  });
});
