import { envValidationSchema } from '../../env.validation';
import { normalizeLiteLlmUrl } from './llm.config';

const connection = {
  MONGODB_URI: 'mongodb://localhost/test',
  LITELLM_BASE_URL: 'http://localhost:4000',
  LITELLM_TEAM_KEY: 'fixture-team-key',
  LITELLM_TEAM_ID: 'team-1',
  LITELLM_DEPLOYMENT_ID: 'deployment-a',
};

it('keeps existing deployments working without LLM configuration and requires a complete identity when enabled', () => {
  expect(
    envValidationSchema.safeParse({ MONGODB_URI: connection.MONGODB_URI })
      .success,
  ).toBe(true);
  expect(envValidationSchema.safeParse(connection).success).toBe(true);
  for (const key of [
    'LITELLM_BASE_URL',
    'LITELLM_TEAM_KEY',
    'LITELLM_TEAM_ID',
    'LITELLM_DEPLOYMENT_ID',
  ]) {
    expect(
      envValidationSchema.safeParse({ ...connection, [key]: undefined })
        .success,
    ).toBe(false);
  }
});

it('normalizes API origins and rejects secret-bearing or non-HTTP URLs', () => {
  expect(normalizeLiteLlmUrl('http://localhost:4000/')).toBe(
    'http://localhost:4000/v1',
  );
  expect(normalizeLiteLlmUrl('https://example.com/llm/v1/')).toBe(
    'https://example.com/llm/v1',
  );
  for (const url of [
    'file:///tmp/test',
    'https://key@example.com',
    'https://example.com/?key=secret',
    'https://example.com/#fragment',
  ]) {
    expect(() => normalizeLiteLlmUrl(url)).toThrow();
    expect(
      envValidationSchema.safeParse({ ...connection, LITELLM_BASE_URL: url })
        .success,
    ).toBe(false);
  }
});
