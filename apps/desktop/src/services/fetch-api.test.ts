import { tauriFetchImpl } from '@daveyplate/better-auth-tauri';
import { beforeEach, expect, it, vi } from 'vitest';

import { fetchApi } from './fetch-api';

vi.mock('@daveyplate/better-auth-tauri', () => ({ tauriFetchImpl: vi.fn() }));
vi.mock('@/stores', () => ({
  useWorkrunStore: {
    getState: () => ({
      config: { team: { server_url: 'https://team.example' } },
    }),
  },
}));
beforeEach(() => vi.mocked(tauriFetchImpl).mockReset());

it.each([
  ['App 订单查询@0.1.0 already exists', 'App 订单查询@0.1.0 already exists'],
  [
    {
      message: 'App 订单查询@0.1.0 already exists',
      error: 'Conflict',
      statusCode: 409,
    },
    'App 订单查询@0.1.0 already exists',
  ],
  [
    { message: ['name should not be empty', 'version must be a string'] },
    'name should not be empty, version must be a string',
  ],
  [undefined, 'Request failed with status 409'],
])('shows the API error text for %j', async (message, expected) => {
  vi.mocked(tauriFetchImpl).mockResolvedValue(
    new Response(JSON.stringify({ errorCode: 409, message }), { status: 409 }),
  );
  await expect(fetchApi.post('/app', { name: '订单查询' })).rejects.toThrow(
    expected,
  );
});

it('unwraps nested errors in a successful HTTP response envelope', async () => {
  vi.mocked(tauriFetchImpl).mockResolvedValue(
    new Response(
      JSON.stringify({
        errorCode: 400,
        message: { message: 'Invalid App definition' },
      }),
    ),
  );
  await expect(fetchApi.post('/app', {})).rejects.toThrow(
    'Invalid App definition',
  );
});

it('shows the actual error from the source archive upload', async () => {
  vi.mocked(tauriFetchImpl).mockResolvedValue(
    new Response(
      JSON.stringify({
        errorCode: 400,
        message: { message: 'Invalid archive type' },
      }),
      { status: 400 },
    ),
  );
  await expect(
    fetchApi.postForm(
      '/app/app-1/versions/version-1/resources/source-archive',
      new FormData(),
    ),
  ).rejects.toThrow('Invalid archive type');
});
