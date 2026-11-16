import { z } from '../../lib/zod';

// Only inference parameters cross this boundary. LiteLLM routing, credentials,
// callbacks, mock responses and arbitrary proxy options are never client-owned.
export const chatSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(z.object({ role: z.string().min(1) }).loose()).min(1),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .strict()
      .optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().optional(),
    stop: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    seed: z.number().int().optional(),
    logprobs: z.boolean().nullable().optional(),
    top_logprobs: z.number().int().optional(),
    logit_bias: z.record(z.string(), z.number()).nullable().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: z.unknown().optional(),
    reasoning_effort: z.string().optional(),
    service_tier: z.string().optional(),
    // These are accepted for client compatibility but always replaced by the server.
    user: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

// Workrun owns conversation history and execution. Provider-side response and
// conversation IDs cannot be trusted as user-scoped under one shared Team Key.
export const responsesSchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z.union([
      z.string(),
      z.array(
        z
          .record(z.string(), z.unknown())
          .refine(
            (item) => item.type !== 'item_reference',
            'Replay input items instead of referencing stored items',
          ),
      ),
    ]),
    instructions: z.string().nullable().optional(),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_obfuscation: z.boolean().optional() })
      .strict()
      .nullable()
      .optional(),
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    max_output_tokens: z.number().int().positive().nullable().optional(),
    max_tool_calls: z.number().int().positive().nullable().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().nullable().optional(),
    text: z.unknown().optional(),
    reasoning: z.unknown().optional(),
    include: z.array(z.string()).nullable().optional(),
    truncation: z.enum(['auto', 'disabled']).nullable().optional(),
    service_tier: z.string().nullable().optional(),
    prompt_cache_retention: z.string().nullable().optional(),
    store: z.literal(false).optional(),
    background: z.literal(false).nullable().optional(),
    previous_response_id: z.null().optional(),
    conversation: z.null().optional(),
    user: z.unknown().optional(),
    safety_identifier: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

export type ApiProtocol = 'chat_completions' | 'responses';
export type InferenceParameters =
  | z.infer<typeof chatSchema>
  | z.infer<typeof responsesSchema>;
