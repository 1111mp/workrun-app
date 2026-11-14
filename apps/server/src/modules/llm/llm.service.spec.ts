import { Writable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';

import { LlmError } from './llm-error';
import { LlmService } from './llm.service';

const settings = {
  LITELLM_BASE_URL: 'http://litellm.test:4000/v1',
  LITELLM_TEAM_KEY: 'fixture-team-key',
  LITELLM_TEAM_ID: 'team-1',
  LITELLM_DEPLOYMENT_ID: 'deployment-a',
  LITELLM_TIMEOUT_MS: 1000,
};

class Downstream extends Writable {
  headers = new Map<string, string>();
  statusCode = 200;
  headersSent = false;
  chunks: Buffer[] = [];
  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }
  status(value: number) {
    this.statusCode = value;
    return this;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  response() {
    return this as unknown as ExpressResponse;
  }
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let service: LlmService;
let infoMock: ReturnType<typeof vi.fn<typeof fetch>>;
let groupMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  infoMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ data: [] }));
  groupMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ data: [] }));
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
      (typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).endsWith('/model/info')
        ? infoMock(input, init)
        : (typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url
            ).endsWith('/model_group/info')
          ? groupMock(input, init)
          : fetchMock(input, init),
  );
  service = new LlmService(new ConfigService(settings));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function models() {
  return Response.json({
    data: [
      { id: 'fast', litellm_params: { api_key: 'never-expose' } },
      { id: 'fast' },
    ],
  });
}
function result() {
  return Response.json(
    { choices: [], usage: { total_tokens: 10 } },
    {
      headers: {
        'x-litellm-call-id': 'call-1',
        'x-litellm-api-key': 'never-expose',
      },
    },
  );
}
const body = { model: 'fast', messages: [{ role: 'user', content: 'hello' }] };

it('fetches models with the team key, caches concurrent discovery and only exposes public metadata', async () => {
  fetchMock.mockResolvedValueOnce(models());
  const [a, b] = await Promise.all([service.models(), service.models()]);
  expect(a).toEqual(b);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
  });
  expect(
    new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization'),
  ).toBe('Bearer fixture-team-key');
  expect(a).toEqual({
    object: 'list',
    data: [
      {
        id: 'fast',
        name: 'fast',
        object: 'model',
        created: 0,
        owned_by: 'workrun',
      },
    ],
  });
  expect(JSON.stringify(a)).not.toContain('never-expose');
});

it('does not cache a failed catalog or substitute local models when the gateway is unavailable', async () => {
  fetchMock
    .mockResolvedValueOnce(
      Response.json({ error: 'fixture-team-key' }, { status: 401 }),
    )
    .mockResolvedValueOnce(models());
  await expect(service.models()).rejects.toMatchObject({ status: 502 });
  await expect(service.models()).resolves.toHaveProperty('object', 'list');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('overwrites client identity and metadata for every user, preserving tools and structured output', async () => {
  fetchMock
    .mockResolvedValueOnce(models())
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result());
  const tools = [
    {
      type: 'function',
      function: {
        name: 'lookup',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  for (const user of ['user-1', 'user-2']) {
    const downstream = new Downstream();
    await service.chat(
      user,
      {
        ...body,
        user: 'victim',
        metadata: { user_api_key: 'attacker', tags: ['forged'] },
        tools,
        response_format: { type: 'json_object' },
      },
      downstream.response(),
    );
    expect(downstream.headers.get('x-litellm-call-id')).toBe('call-1');
    expect(downstream.headers.has('x-litellm-api-key')).toBe(false);
    expect(
      JSON.parse(Buffer.concat(downstream.chunks).toString()).usage
        .total_tokens,
    ).toBe(10);
  }
  const sent = fetchMock.mock.calls
    .slice(1)
    .map(([, options]) => JSON.parse(options!.body as string));
  expect(sent.map((request) => request.user)).toEqual([
    'workrun:deployment-a:user-1',
    'workrun:deployment-a:user-2',
  ]);
  for (const request of sent) {
    expect(request.tools).toEqual(tools);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.metadata).toEqual({
      workrun_request_id: expect.any(String),
      workrun_team_id: 'team-1',
    });
  }
});

it('rejects unsupported routing and unlisted model parameters before generation', async () => {
  fetchMock.mockResolvedValueOnce(models());
  for (const extra of [
    { api_key: 'attacker' },
    { api_base: 'http://attacker' },
    { litellm_params: {} },
    { mock_response: 'fake' },
    { fallbacks: ['other'] },
  ]) {
    await expect(
      service.chat(
        'user-1',
        { ...body, ...extra },
        new Downstream().response(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  }
  await expect(
    service.chat(
      'user-1',
      { ...body, model: 'private-model' },
      new Downstream().response(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('returns quota errors without leaking upstream bodies or retrying the completion', async () => {
  fetchMock
    .mockResolvedValueOnce(models())
    .mockResolvedValueOnce(
      Response.json(
        { error: 'fixture-team-key' },
        { status: 429, headers: { 'Retry-After': '12' } },
      ),
    );
  const downstream = new Downstream();
  try {
    await service.chat('user-1', body, downstream.response());
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).getStatus()).toBe(429);
    expect(JSON.stringify((error as LlmError).getResponse())).not.toContain(
      'fixture-team-key',
    );
  }
  expect(downstream.headers.get('retry-after')).toBe('12');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('forwards SSE bytes before the upstream finishes, including fragmented tool calls and usage tails', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  fetchMock.mockResolvedValueOnce(models()).mockResolvedValueOnce(
    new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  const downstream = new Downstream();
  const pending = service.chat(
    'user-1',
    { ...body, stream: true, stream_options: { include_usage: true } },
    downstream.response(),
  );
  const first =
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1"}]}}]}\n\n';
  source.enqueue(new TextEncoder().encode(first));
  await vi.waitFor(() =>
    expect(Buffer.concat(downstream.chunks).toString()).toBe(first),
  );
  expect(downstream.writableFinished).toBe(false);
  const last =
    'data: {"choices":[],"usage":{"total_tokens":15}}\n\ndata: [DONE]\n\n';
  source.enqueue(new TextEncoder().encode(last));
  source.close();
  await pending;
  expect(Buffer.concat(downstream.chunks).toString()).toBe(first + last);
  expect(downstream.headers.get('x-accel-buffering')).toBe('no');
});

it('aborts the upstream fetch when the client disconnects', async () => {
  fetchMock.mockResolvedValueOnce(models()).mockImplementationOnce(
    async (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(options!.signal!.reason),
          { once: true },
        );
      }),
  );
  const downstream = new Downstream();
  const pending = service.chat('user-1', body, downstream.response());
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  downstream.destroy();
  await pending;
  expect(fetchMock.mock.calls[1][1]!.signal!.aborted).toBe(true);
  expect(downstream.listenerCount('close')).toBe(0);
});

it('times out upstream requests without retrying and reports an OpenAI-shaped timeout', async () => {
  service = new LlmService(
    new ConfigService({ ...settings, LITELLM_TIMEOUT_MS: 20 }),
  );
  fetchMock.mockResolvedValueOnce(models()).mockImplementationOnce(
    async (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(options!.signal!.reason),
          { once: true },
        );
      }),
  );
  await expect(
    service.chat('user-1', body, new Downstream().response()),
  ).rejects.toMatchObject({ status: 504 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('applies the request deadline while waiting for shared model discovery', async () => {
  service = new LlmService(
    new ConfigService({ ...settings, LITELLM_TIMEOUT_MS: 20 }),
  );
  let resolveCatalog!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    async () =>
      new Promise<Response>((resolve) => {
        resolveCatalog = resolve;
      }),
  );
  await expect(
    service.chat('user-1', body, new Downstream().response()),
  ).rejects.toMatchObject({ status: 504 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolveCatalog(models());
  await expect(service.models()).resolves.toHaveProperty('object', 'list');
});

it('adapts configured JSON output before forwarding to the gateway', async () => {
  service = new LlmService(
    new ConfigService({
      ...settings,
      LITELLM_JSON_OBJECT_MODELS: 'fast',
    }),
  );
  fetchMock.mockResolvedValueOnce(models()).mockResolvedValueOnce(result());
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  await service.chat(
    'user-1',
    {
      ...body,
      response_format: { type: 'json_schema', json_schema: { schema } },
    },
    new Downstream().response(),
  );
  const sent = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
  expect(sent.response_format).toEqual({ type: 'json_object' });
  expect(sent.messages.at(-1)).toEqual({
    role: 'system',
    content: `Return only a JSON object conforming to this JSON Schema:\n${JSON.stringify(schema)}`,
  });
  expect(sent.user).toBe('workrun:deployment-a:user-1');
});

it('does not inherit unrelated OpenAI organization or project settings', async () => {
  vi.stubEnv('OPENAI_ORG_ID', 'unrelated-organization');
  vi.stubEnv('OPENAI_PROJECT_ID', 'unrelated-project');
  vi.stubEnv('OPENAI_LOG', 'debug');
  fetchMock.mockResolvedValueOnce(models()).mockResolvedValueOnce(result());
  await service.chat('user-1', body, new Downstream().response());
  for (const [, options] of fetchMock.mock.calls) {
    const headers = new Headers(options?.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture-team-key');
    expect(headers.has('openai-organization')).toBe(false);
    expect(headers.has('openai-project')).toBe(false);
    expect(options?.redirect).toBe('error');
  }
});

it('uses the Responses endpoint and preserves input items, reasoning, and structured text output', async () => {
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: 'lookup' }] },
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'lookup',
      arguments: '{}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{"answer":42}',
    },
    { type: 'reasoning', encrypted_content: 'opaque-reasoning-context' },
  ];
  const output = {
    id: 'resp-test',
    object: 'response',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: '{"answer":42}' }],
      },
    ],
    usage: { total_tokens: 10 },
  };
  fetchMock
    .mockResolvedValueOnce(models())
    .mockResolvedValueOnce(Response.json(output));
  const downstream = new Downstream();
  await service.responses(
    'user-1',
    {
      model: 'fast',
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'result',
          schema: { type: 'object' },
          strict: true,
        },
      },
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      user: 'forged-user',
      safety_identifier: 'forged-safety-id',
      metadata: { workrun_team_id: 'forged-team' },
    },
    downstream.response(),
  );
  expect(fetchMock.mock.calls[1][0]).toBe(
    `${settings.LITELLM_BASE_URL}/responses`,
  );
  const sent = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
  expect(sent.input).toEqual(input);
  expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  expect(sent.text.format.type).toBe('json_schema');
  expect(sent.include).toEqual(['reasoning.encrypted_content']);
  expect(sent.user).toBe('workrun:deployment-a:user-1');
  expect(sent.safety_identifier).toMatch(/^[a-f0-9]{64}$/);
  expect(sent.store).toBe(false);
  expect(sent.metadata).toEqual({
    workrun_request_id: expect.any(String),
    workrun_team_id: 'team-1',
  });
  expect(JSON.parse(Buffer.concat(downstream.chunks).toString())).toEqual(
    output,
  );
});

it('rejects Responses routing overrides and provider-owned state under the shared team credential', async () => {
  for (const extra of [
    { api_key: 'forged' },
    { api_base: 'http://forged' },
    { fallbacks: ['other'] },
    { mock_response: 'fake' },
    { store: true },
    { background: true },
    { previous_response_id: 'another-users-response' },
    { conversation: 'another-users-conversation' },
    { input: [{ type: 'item_reference', id: 'another-users-item' }] },
    { response_format: { type: 'json_object' } },
  ]) {
    await expect(
      service.responses(
        'user-1',
        { model: 'fast', input: 'hello', ...extra },
        new Downstream().response(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it('discovers public capabilities from LiteLLM without manual configuration or broadening visibility', async () => {
  infoMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          model_name: 'fast',
          litellm_params: { api_key: 'never-expose' },
          model_info: {
            supports_function_calling: true,
            supports_vision: false,
            supports_response_schema: true,
            supported_endpoints: ['/v1/chat/completions', '/v1/responses'],
            api_key: 'never-expose',
          },
        },
        {
          model_name: 'not-authorized',
          model_info: { supports_function_calling: true },
        },
      ],
    }),
  );
  fetchMock.mockResolvedValueOnce(models());
  const catalog = await service.models();
  expect(catalog.data).toHaveLength(1);
  expect(catalog.data[0]).toMatchObject({
    id: 'fast',
    apiProtocols: ['chat_completions', 'responses'],
    capabilities: { tools: true, vision: false, structuredOutput: true },
  });
  expect(JSON.stringify(catalog)).not.toContain('never-expose');
  expect(
    new Headers(infoMock.mock.calls[0][1]?.headers).get('authorization'),
  ).toBe('Bearer fixture-team-key');
});

it.each([403, 404, 500])(
  'keeps models usable when capability discovery returns %s',
  async (status) => {
    infoMock.mockResolvedValueOnce(
      Response.json({ error: 'no metadata' }, { status }),
    );
    fetchMock.mockResolvedValueOnce(models()).mockResolvedValueOnce(result());
    expect((await service.models()).data[0]).not.toHaveProperty('capabilities');
    await service.chat(
      'user-1',
      {
        ...body,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
      new Downstream().response(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

it('leaves conflicting pooled capabilities unknown and treats endpoint metadata as hints', async () => {
  infoMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          model_name: 'fast',
          model_info: {
            supports_function_calling: true,
            supported_endpoints: ['/v1/chat/completions'],
          },
        },
        {
          model_name: 'fast',
          model_info: {
            supports_function_calling: false,
            supported_endpoints: ['/v1/chat/completions'],
          },
        },
      ],
    }),
  );
  fetchMock
    .mockResolvedValueOnce(models())
    .mockResolvedValueOnce(Response.json({ id: 'resp-test', output: [] }));
  expect((await service.models()).data[0]).not.toHaveProperty('capabilities');
  await service.responses(
    'user-1',
    { model: 'fast', input: 'hello' },
    new Downstream().response(),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('applies the same model authorization, quota mapping, and total deadline to Responses', async () => {
  fetchMock
    .mockResolvedValueOnce(models())
    .mockResolvedValueOnce(
      Response.json(
        { error: 'private-gateway-data' },
        { status: 429, headers: { 'retry-after': '5' } },
      ),
    );
  await expect(
    service.responses(
      'user-1',
      { model: 'unlisted', input: 'hello' },
      new Downstream().response(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  const downstream = new Downstream();
  await expect(
    service.responses(
      'user-1',
      { model: 'fast', input: 'hello' },
      downstream.response(),
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(downstream.headers.get('retry-after')).toBe('5');
  expect(fetchMock).toHaveBeenCalledTimes(2);

  service = new LlmService(
    new ConfigService({ ...settings, LITELLM_TIMEOUT_MS: 20 }),
  );
  fetchMock.mockResolvedValueOnce(models()).mockImplementationOnce(
    async (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(options!.signal!.reason),
          { once: true },
        );
      }),
  );
  await expect(
    service.responses(
      'user-1',
      { model: 'fast', input: 'hello' },
      new Downstream().response(),
    ),
  ).rejects.toMatchObject({ status: 504 });
});

it('publishes model-group reasoning levels in stable order, scoped to visible models', async () => {
  groupMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          model_group: 'fast',
          supported_reasoning_efforts: [
            'max',
            'high',
            'minimal',
            'none',
            'xhigh',
            'low',
            'medium',
            'high',
            'future',
          ],
        },
        { model_group: 'hidden', supported_reasoning_efforts: ['high'] },
      ],
    }),
  );
  fetchMock.mockResolvedValueOnce(models());
  const catalog = await service.models();
  expect(catalog.data).toHaveLength(1);
  expect(catalog.data[0].capabilities?.reasoningEfforts).toEqual([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  await service.models();
  expect(groupMock).toHaveBeenCalledTimes(1);
});

it('uses the intersection of reasoning levels for pooled deployments', async () => {
  infoMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          model_name: 'fast',
          model_info: { supported_reasoning_efforts: ['low', 'high', 'xhigh'] },
        },
        {
          model_name: 'fast',
          model_info: { reasoning_effort_levels: ['medium', 'high', 'xhigh'] },
        },
      ],
    }),
  );
  groupMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          model_group: 'fast',
          supported_reasoning_efforts: ['low', 'medium', 'high'],
        },
      ],
    }),
  );
  fetchMock.mockResolvedValueOnce(models());
  expect(
    (await service.models()).data[0].capabilities?.reasoningEfforts,
  ).toEqual(['high']);
});

it.each([null, ['bad'], undefined])(
  'does not invent effort levels from supports_reasoning alone (%j)',
  async (levels) => {
    infoMock.mockResolvedValueOnce(
      Response.json({
        data: [
          { model_name: 'fast', model_info: { supports_reasoning: true } },
        ],
      }),
    );
    groupMock.mockResolvedValueOnce(
      Response.json({
        data: [{ model_group: 'fast', supported_reasoning_efforts: levels }],
      }),
    );
    fetchMock.mockResolvedValueOnce(models());
    expect(
      (await service.models()).data[0].capabilities?.reasoningEfforts ?? [],
    ).toEqual([]);
  },
);

it('retains deployment levels when the optional group endpoint is unavailable', async () => {
  groupMock.mockResolvedValueOnce(Response.json({}, { status: 403 }));
  infoMock.mockResolvedValueOnce(
    Response.json({
      data: [
        {
          model_name: 'fast',
          model_info: { reasoning_effort_levels: ['low', 'high'] },
        },
      ],
    }),
  );
  fetchMock.mockResolvedValueOnce(models());
  expect(
    (await service.models()).data[0].capabilities?.reasoningEfforts,
  ).toEqual(['low', 'high']);
});
