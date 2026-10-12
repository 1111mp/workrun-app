import { describe, expect, it } from 'vitest';

import { providerCredentialSchema } from './settings-schema';

const credential = { provider: 'open_ai', apiKey: 'test-key', headers: [] };

describe('provider custom headers', () => {
  it('accepts static gateway headers for supported providers', () => {
    for (const provider of ['open_ai', 'open_ai_strict', 'anthropic']) {
      expect(
        providerCredentialSchema.safeParse({
          ...credential,
          provider,
          headers: [{ name: 'X-Tenant-ID', value: 'team-a' }],
        }).success,
      ).toBe(true);
    }
  });

  it('rejects duplicate names, header injection, managed headers, and unsupported providers', () => {
    for (const headers of [
      [
        { name: 'X-Tenant', value: 'one' },
        { name: 'x-tenant', value: 'two' },
      ],
      [{ name: 'bad name', value: 'secret' }],
      [{ name: 'X-Tenant', value: 'one\r\nAuthorization: secret' }],
      [{ name: 'AUTHORIZATION', value: 'secret' }],
      [{ name: 'X-API-Key', value: 'secret' }],
      [{ name: 'Content-Length', value: '0' }],
    ]) {
      expect(
        providerCredentialSchema.safeParse({ ...credential, headers }).success,
      ).toBe(false);
    }
    expect(
      providerCredentialSchema.safeParse({
        ...credential,
        provider: 'deep_seek',
        headers: [{ name: 'X-Tenant', value: 'a' }],
      }).success,
    ).toBe(false);
    expect(
      providerCredentialSchema.safeParse({ ...credential, provider: 'ollama' })
        .success,
    ).toBe(true);
  });

  it('supports removing every custom header', () => {
    expect(providerCredentialSchema.parse(credential).headers).toEqual([]);
  });
});
