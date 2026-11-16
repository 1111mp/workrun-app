import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Controller, Get, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';

import { AllExceptionsFilter } from '../../filters/all-exception.filter';
import { RespTransformInterceptor } from '../../interceptors/resp-transform.interceptor';
import { LlmModule } from './llm.module';

@Controller('health')
class HealthController {
  @Get()
  get() {
    return { ok: true };
  }
}

type UpstreamRequest = {
  path: string;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
};
let upstream: Server;
let app: NestExpressApplication;
let base: string;
let requests: UpstreamRequest[];
let mode: 'json' | 'stream' | 'cancel' | 'quota' | 'redirect';
let releaseStream: (() => void) | undefined;
let upstreamClosed: boolean;
let config: ConfigService;

beforeEach(async () => {
  requests = [];
  mode = 'json';
  releaseStream = undefined;
  upstreamClosed = false;
  upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      path: req.url!,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : {},
    });
    if (req.url === '/v1/model/info' || req.url === '/model_group/info') {
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ id: 'fast', api_key: 'hidden-upstream-key' }],
        }),
      );
      return;
    }
    if (mode === 'quota') {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '10',
      });
      res.end(
        JSON.stringify({
          error: { message: 'secret-team-key should never reach clients' },
        }),
      );
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(307, {
        Location: 'https://never-contact.example/chat/completions',
      });
      res.end();
      return;
    }
    if (mode === 'stream' || mode === 'cancel') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'x-litellm-call-id': 'upstream-call',
      });
      res.write(
        req.url === '/v1/responses'
          ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
          : 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      );
      res.on('close', () => {
        upstreamClosed = true;
      });
      if (mode === 'stream') {
        releaseStream = () =>
          res.end(
            req.url === '/v1/responses'
              ? 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-test","usage":{"total_tokens":15}}}\n\n'
              : 'data: {"choices":[],"usage":{"total_tokens":15}}\n\ndata: [DONE]\n\n',
          );
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'x-litellm-call-id': 'upstream-call',
      'x-litellm-api-key': 'hidden-upstream-key',
    });
    if (req.url === '/v1/responses') {
      res.end(
        JSON.stringify({
          id: 'resp-test',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'lookup',
              arguments: '{}',
            },
          ],
          usage: { total_tokens: 15 },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  config = new ConfigService({
    LITELLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    LITELLM_TEAM_KEY: 'secret-team-key',
    LITELLM_TEAM_ID: 'team-1',
    LITELLM_DEPLOYMENT_ID: 'test-deployment',
    LITELLM_TIMEOUT_MS: 2000,
  });
  const module = await Test.createTestingModule({
    imports: [LlmModule],
    controllers: [HealthController],
  })
    .overrideProvider(ConfigService)
    .useValue(config)
    .compile();
  app = module.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    prefix: false,
    defaultVersion: 'v1',
  });
  // Exercise the actual production guard and session decorator. Only the auth
  // provider's session lookup is replaced, so no real database/user is needed.
  app.useGlobalGuards(
    new AuthGuard(new Reflector(), {
      auth: {
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            const token = headers.get('authorization');
            const id =
              token === 'Bearer session-a'
                ? 'user-a'
                : token === 'Bearer session-b'
                  ? 'user-b'
                  : undefined;
            return id ? { user: { id }, session: { id: 'session' } } : null;
          },
        },
      },
    } as unknown as ConstructorParameters<typeof AuthGuard>[1]),
  );
  app.useGlobalInterceptors(new RespTransformInterceptor());
  app.useGlobalFilters(
    new AllExceptionsFilter({ error: vi.fn() } as unknown as Logger),
  );
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterEach(async () => {
  releaseStream?.();
  await app?.close();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

function chat(options: Record<string, unknown> = {}, token = 'session-a') {
  return fetch(`${base}/api/v1/llm/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-litellm-end-user-id': 'forged-user',
      'x-api-key': 'forged-key',
    },
    body: JSON.stringify({
      model: 'fast',
      messages: [{ role: 'user', content: 'hello' }],
      ...options,
    }),
  });
}

it('authenticates both model endpoints and keeps regular business envelopes unchanged', async () => {
  for (const path of ['models', 'chat/completions', 'responses']) {
    const response = await fetch(
      `${base}/api/v1/llm/${path}`,
      path === 'models'
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: '401' } });
  }
  expect(requests).toHaveLength(0);
  const models = await fetch(`${base}/api/v1/llm/models`, {
    headers: { Authorization: 'Bearer session-a' },
  });
  expect(models.status).toBe(200);
  const catalog = await models.json();
  expect(catalog).toMatchObject({ object: 'list', data: [{ id: 'fast' }] });
  expect(catalog).not.toHaveProperty('payload');
  expect(JSON.stringify(catalog)).not.toContain('hidden-upstream-key');
  const health = await fetch(`${base}/api/v1/health`, {
    headers: { Authorization: 'Bearer session-a' },
  });
  expect(await health.json()).toEqual({ errorCode: 0, payload: { ok: true } });
});

it('returns raw completions and binds attribution to each authenticated session', async () => {
  for (const token of ['session-a', 'session-b']) {
    const response = await chat(
      {
        user: 'victim',
        metadata: { user_api_key: 'forged-key' },
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        reasoning_effort: 'high',
      },
      token,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-litellm-call-id')).toBe('upstream-call');
    expect(response.headers.has('x-litellm-api-key')).toBe(false);
    const body = await response.json();
    expect(body.usage.total_tokens).toBe(15);
    expect(body).not.toHaveProperty('payload');
  }
  const completions = requests.filter((request) =>
    request.path.endsWith('/chat/completions'),
  );
  expect(completions.map((request) => request.body.user)).toEqual([
    'workrun:test-deployment:user-a',
    'workrun:test-deployment:user-b',
  ]);
  for (const request of completions) {
    expect(request.headers.authorization).toBe('Bearer secret-team-key');
    expect(request.headers['x-litellm-end-user-id']).toBeUndefined();
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.body.metadata).toEqual({
      workrun_request_id: expect.any(String),
      workrun_team_id: 'team-1',
    });
    expect(request.body.reasoning_effort).toBe('high');
  }
});

it('delivers the first SSE event while the upstream is still open', async () => {
  mode = 'stream';
  const response = await chat({
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('hello');
  expect(first.done).toBe(false);
  releaseStream!();
  let tail = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    tail += new TextDecoder().decode(chunk.value);
  }
  expect(tail).toContain('"total_tokens":15');
  expect(tail).toContain('[DONE]');
});

it('disconnects the upstream when the streaming client cancels', async () => {
  mode = 'cancel';
  const response = await chat({ stream: true });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await vi.waitFor(() => expect(upstreamClosed).toBe(true));
});

it('preserves quota status and retry hints while sanitizing errors and disabling redirects', async () => {
  mode = 'quota';
  const response = await chat();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('10');
  const error = await response.json();
  expect(error).toMatchObject({
    error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  });
  expect(JSON.stringify(error)).not.toContain('secret-team-key');
  mode = 'redirect';
  const redirected = await chat();
  expect(redirected.status).toBe(502);
  await redirected.body?.cancel();
});

it('returns protocol errors for invalid JSON and unavailable configuration without upstream calls', async () => {
  const malformed = await fetch(`${base}/api/v1/llm/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer session-a',
      'Content-Type': 'application/json',
    },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toHaveProperty('error');
  vi.spyOn(config, 'get').mockReturnValue(undefined);
  const response = await chat();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: 'llm_not_configured' },
  });
  expect(requests).toHaveLength(0);
});

function responses(options: Record<string, unknown> = {}, token = 'session-a') {
  return fetch(`${base}/api/v1/llm/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-litellm-end-user-id': 'forged-user',
    },
    body: JSON.stringify({ model: 'fast', input: 'hello', ...options }),
  });
}

it('returns raw Responses output items and attributes both users using server identity', async () => {
  for (const token of ['session-a', 'session-b']) {
    const response = await responses(
      {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call-1',
            output: '{"answer":42}',
          },
        ],
        reasoning: { effort: 'high' },
        text: { format: { type: 'json_object' } },
        user: 'victim',
        safety_identifier: 'victim',
        metadata: { workrun_team_id: 'victim' },
      },
      token,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe('response');
    expect(body.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call-1',
    });
    expect(body).not.toHaveProperty('payload');
  }
  const generated = requests.filter(
    (request) => request.path === '/v1/responses',
  );
  expect(generated.map((request) => request.body.user)).toEqual([
    'workrun:test-deployment:user-a',
    'workrun:test-deployment:user-b',
  ]);
  expect(generated[0].body.safety_identifier).not.toEqual(
    generated[1].body.safety_identifier,
  );
  for (const request of generated) {
    expect(request.body.store).toBe(false);
    expect(request.body.safety_identifier).toMatch(/^[a-f0-9]{64}$/);
    expect(request.body.metadata).toEqual({
      workrun_request_id: expect.any(String),
      workrun_team_id: 'team-1',
    });
    expect(request.headers.authorization).toBe('Bearer secret-team-key');
    expect(request.headers['x-litellm-end-user-id']).toBeUndefined();
  }
});

it('streams typed Responses events before completion without converting them to chat chunks', async () => {
  mode = 'stream';
  const response = await responses({ stream: true });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const first = await reader.read();
  const firstText = new TextDecoder().decode(first.value);
  expect(firstText).toContain('event: response.output_text.delta');
  expect(firstText).toContain('"delta":"hello"');
  expect(first.done).toBe(false);
  releaseStream!();
  let tail = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    tail += new TextDecoder().decode(chunk.value);
  }
  expect(tail).toContain('event: response.completed');
  expect(tail).toContain('"total_tokens":15');
  expect(tail).not.toContain('[DONE]');
});

it('aborts an active Responses stream when its client disconnects', async () => {
  mode = 'cancel';
  const response = await responses({ stream: true });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await vi.waitFor(() => expect(upstreamClosed).toBe(true));
});

it('rejects unsupported Responses state and forwards sanitized quota errors without retries', async () => {
  for (const state of [
    { store: true },
    { previous_response_id: 'other-user-response' },
    { conversation: 'other-user-conversation' },
    { background: true },
  ]) {
    const rejected = await responses(state);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toHaveProperty('error');
  }
  expect(requests).toHaveLength(0);
  mode = 'quota';
  const limited = await responses();
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('10');
  expect(JSON.stringify(await limited.json())).not.toContain('secret-team-key');
  expect(
    requests.filter((request) => request.path === '/v1/responses'),
  ).toHaveLength(1);
});
