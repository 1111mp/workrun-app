import { z } from '../../lib/zod';

export const modelCatalogSchema = z.record(
  z.string().min(1),
  z
    .object({
      name: z.string().min(1).optional(),
      apiProtocols: z
        .array(z.enum(['chat_completions', 'responses']))
        .min(1)
        .optional(),
      capabilities: z
        .object({
          tools: z.boolean().optional(),
          structuredOutput: z.boolean().optional(),
          vision: z.boolean().optional(),
          reasoningEfforts: z
            .array(z.enum(['low', 'medium', 'high']))
            .optional(),
        })
        .optional(),
    })
    .strict(),
);

export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export function parseModelCatalog(value: string): ModelCatalog {
  return modelCatalogSchema.parse(JSON.parse(value));
}

export function normalizeLiteLlmUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'LiteLLM URL must be HTTP(S) without credentials, query or fragment',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.toString().replace(/\/+$/, '');
}
