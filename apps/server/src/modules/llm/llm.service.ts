import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';
import OpenAI from 'openai';

import { LlmError } from './llm-error';
import {
  modelInfoSchema,
  modelGroupSchema,
  modelListSchema,
  publicModel,
  type TeamModel,
  type ModelInfo,
  type ModelGroup,
} from './llm.catalog';
import { normalizeLiteLlmUrl } from './llm.config';
import { adaptJsonOutput } from './llm.output';
import {
  chatSchema,
  responsesSchema,
  type ApiProtocol,
  type InferenceParameters,
} from './llm.schemas';
import { ChatUsageStream } from './llm.stream';

@Injectable()
export class LlmService {
  private sdk?: OpenAI;
  private cachedModels?: { expires: number; models: TeamModel[] };
  private loadingModels?: Promise<TeamModel[]>;

  constructor(private readonly config: ConfigService) {}

  private settings() {
    const base = this.config.get<string>('LITELLM_BASE_URL');
    const key = this.config.get<string>('LITELLM_TEAM_KEY');
    const teamId = this.config.get<string>('LITELLM_TEAM_ID');
    const deploymentId = this.config.get<string>('LITELLM_DEPLOYMENT_ID');
    if (!base || !key || !teamId || !deploymentId) {
      throw new LlmError(
        503,
        'Team model service is not configured.',
        'server_error',
        'llm_not_configured',
      );
    }
    return {
      base: normalizeLiteLlmUrl(base),
      key,
      teamId,
      deploymentId,
      timeout: this.config.get<number>('LITELLM_TIMEOUT_MS') ?? 300_000,
    };
  }

  private client(settings: {
    base: string;
    key: string;
    timeout: number;
  }): OpenAI {
    // Connection settings are deployment-owned and take effect on restart.
    // Disable SDK logging/retries so prompts stay private and LiteLLM owns retries.
    return (this.sdk ??= new OpenAI({
      baseURL: settings.base,
      apiKey: settings.key,
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: settings.timeout,
      logLevel: 'off',
      fetchOptions: { redirect: 'error' },
    }));
  }

  private async modelInfo(settings: {
    base: string;
    key: string;
    timeout: number;
  }): Promise<ModelInfo[]> {
    try {
      const response = await this.client(settings)
        .get('/model/info', {
          timeout: 3000,
          signal: AbortSignal.timeout(3000),
        })
        .asResponse();
      const parsed = modelInfoSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.data : [];
    } catch {
      // Metadata discovery is optional: older proxies or AI-only keys may deny it.
      return [];
    }
  }

  private async modelGroups(settings: {
    base: string;
    key: string;
    timeout: number;
  }): Promise<ModelGroup[]> {
    try {
      // LiteLLM exposes the group route outside /v1; retain any deployment prefix.
      const url = `${settings.base.replace(/\/v1$/, '')}/model_group/info`;
      const response = await this.client(settings)
        .get(url, {
          timeout: 3000,
          signal: AbortSignal.timeout(3000),
        })
        .asResponse();
      const parsed = modelGroupSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.data : [];
    } catch {
      return [];
    }
  }

  async models() {
    return { object: 'list', data: await this.catalog() };
  }

  private async catalog(): Promise<TeamModel[]> {
    if (this.cachedModels && this.cachedModels.expires > Date.now())
      return this.cachedModels.models;
    // Concurrent turns share discovery. Failed refreshes never authorize a
    // request using an expired model list.
    this.loadingModels ??= this.loadModels().finally(() => {
      this.loadingModels = undefined;
    });
    return this.loadingModels;
  }

  private catalogForRequest(signal: AbortSignal): Promise<TeamModel[]> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Discovery is shared. Cancelling one caller must stop its wait without
      // aborting discovery for other active requests.
      void this.catalog().then(
        (models) => {
          signal.removeEventListener('abort', onAbort);
          resolve(models);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async loadModels(): Promise<TeamModel[]> {
    const settings = this.settings();
    let response: Response;
    try {
      response = await this.client(settings)
        .models.list({
          signal: AbortSignal.timeout(15_000),
          timeout: 15_000,
        })
        .asResponse();
    } catch (error) {
      if (error instanceof OpenAI.APIError && error.status !== undefined) {
        throw this.upstreamError(error.status);
      }
      throw new LlmError(
        502,
        'Could not read the team model catalog.',
        'server_error',
        'upstream_unavailable',
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new LlmError(
        502,
        'Invalid team model catalog.',
        'server_error',
        'invalid_upstream_response',
      );
    }
    const parsed = modelListSchema.safeParse(data);
    if (!parsed.success)
      throw new LlmError(
        502,
        'Invalid team model catalog.',
        'server_error',
        'invalid_upstream_response',
      );
    const [info, groups] = await Promise.all([
      this.modelInfo(settings),
      this.modelGroups(settings),
    ]);
    // /models remains the authority for visibility, even if /model/info is broader.
    const models = [...new Set(parsed.data.data.map((model) => model.id))].map(
      (id) =>
        publicModel(
          id,
          info.filter((entry) => entry.model_name === id),
          groups.filter((group) => group.model_group === id),
        ),
    );
    this.cachedModels = { models, expires: Date.now() + 30_000 };
    return models;
  }

  async chat(
    userId: string,
    body: unknown,
    downstream: ExpressResponse,
  ): Promise<void> {
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success)
      throw new LlmError(
        400,
        'Invalid or unsupported chat completion parameters.',
        'invalid_request_error',
        'invalid_request',
      );
    return this.generate('chat_completions', userId, parsed.data, downstream);
  }

  async responses(
    userId: string,
    body: unknown,
    downstream: ExpressResponse,
  ): Promise<void> {
    const parsed = responsesSchema.safeParse(body);
    if (!parsed.success)
      throw new LlmError(
        400,
        'Invalid or unsupported Responses parameters; use stateless input replay with store=false.',
        'invalid_request_error',
        'invalid_request',
      );
    return this.generate('responses', userId, parsed.data, downstream);
  }

  private async generate(
    protocol: ApiProtocol,
    userId: string,
    parameters: InferenceParameters,
    downstream: ExpressResponse,
  ): Promise<void> {
    if (!userId)
      throw new LlmError(
        401,
        'Sign in to use team models.',
        'authentication_error',
        'unauthorized',
      );
    const settings = this.settings();
    const abort = new AbortController();
    const onClose = () => {
      if (!downstream.writableFinished) abort.abort();
    };
    downstream.on('close', onClose);
    const timer = setTimeout(
      () => abort.abort(new Error('timeout')),
      settings.timeout,
    );
    timer.unref();
    const requestId = randomUUID();
    downstream.setHeader('x-workrun-request-id', requestId);
    try {
      const models = await this.catalogForRequest(abort.signal);
      const model = models.find((model) => model.id === parameters.model);
      if (!model) {
        throw new LlmError(
          403,
          'This model is not available to the team.',
          'permission_error',
          'model_not_allowed',
        );
      }
      // Advertised endpoints are discovery hints; LiteLLM owns protocol adaptation
      // and validates the actual request for both supported gateway routes.
      abort.signal.throwIfAborted();
      const endUser = `workrun:${settings.deploymentId}:${encodeURIComponent(userId)}`;
      // Input schemas restrict external JSON to inference parameters. Identity
      // fields are assigned last, so neither protocol can override attribution.
      const request = {
        ...adaptJsonOutput(
          parameters,
          this.config.get<string>('LITELLM_JSON_OBJECT_MODELS') ?? '',
        ),
        user: endUser,
        metadata: {
          workrun_request_id: requestId,
          workrun_team_id: settings.teamId,
        },
      };
      const options = {
        signal: abort.signal,
        headers: {
          Accept: parameters.stream ? 'text/event-stream' : 'application/json',
        },
      };
      const client = this.client(settings);
      const upstream =
        protocol === 'chat_completions'
          ? await client.chat.completions
              .create(
                request as OpenAI.Chat.Completions.ChatCompletionCreateParams,
                options,
              )
              .asResponse()
          : await client.responses
              .create(
                {
                  ...request,
                  store: false,
                  // Responses also has a provider-facing safety identity. Do not let
                  // it diverge from the Workrun user, and keep it within 128 characters.
                  safety_identifier: createHash('sha256')
                    .update(endUser)
                    .digest('hex'),
                } as OpenAI.Responses.ResponseCreateParams,
                options,
              )
              .asResponse();
      this.forwardHeaders(upstream.headers, downstream);
      const mime = upstream.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase();
      const expected = parameters.stream
        ? 'text/event-stream'
        : 'application/json';
      if (!upstream.body || mime !== expected) {
        await upstream.body?.cancel();
        throw new LlmError(
          502,
          'Invalid response from the model gateway.',
          'server_error',
          'invalid_upstream_response',
        );
      }
      downstream.status(upstream.status);
      downstream.setHeader('Content-Type', `${expected}; charset=utf-8`);
      downstream.setHeader('Cache-Control', 'no-store');
      downstream.setHeader('X-Accel-Buffering', 'no');
      downstream.flushHeaders();
      const source = Readable.fromWeb(
        upstream.body as unknown as NodeReadableStream<Uint8Array>,
      );
      // ADK expects usage-only Chat frames to have choices: [].
      if (protocol === 'chat_completions' && parameters.stream) {
        await pipeline(source, new ChatUsageStream(), downstream, {
          signal: abort.signal,
        });
      } else {
        await pipeline(source, downstream, { signal: abort.signal });
      }
    } catch (error) {
      abort.abort();
      if (downstream.destroyed) return;
      if (downstream.headersSent) {
        downstream.destroy();
        return;
      }
      if (error instanceof LlmError) throw error;
      if (error instanceof OpenAI.APIError && error.status !== undefined) {
        this.forwardHeaders(error.headers, downstream);
        throw this.upstreamError(error.status);
      }
      throw new LlmError(
        error instanceof OpenAI.APIConnectionTimeoutError ||
          (abort.signal.reason instanceof Error &&
            abort.signal.reason.message === 'timeout')
          ? 504
          : 502,
        'The model gateway request could not be completed.',
        'server_error',
        'upstream_request_failed',
      );
    } finally {
      clearTimeout(timer);
      downstream.off('close', onClose);
    }
  }

  private forwardHeaders(
    headers: Headers | undefined,
    downstream: ExpressResponse,
  ) {
    for (const name of ['x-request-id', 'x-litellm-call-id', 'retry-after']) {
      const value = headers?.get(name);
      if (value) downstream.setHeader(name, value);
    }
  }

  private upstreamError(status: number): LlmError {
    if (status === 401)
      return new LlmError(
        502,
        'The model gateway credentials were rejected.',
        'server_error',
        'upstream_auth_error',
      );
    if (status === 429)
      return new LlmError(
        429,
        'The model budget or rate limit was exceeded.',
        'rate_limit_error',
        'rate_limit_exceeded',
      );
    if (status === 403)
      return new LlmError(
        403,
        'The model gateway denied access.',
        'permission_error',
        'model_access_denied',
      );
    return new LlmError(
      status >= 400 && status <= 599 ? status : 502,
      'The model gateway rejected the request.',
      status < 500 ? 'invalid_request_error' : 'server_error',
      'upstream_error',
    );
  }
}
