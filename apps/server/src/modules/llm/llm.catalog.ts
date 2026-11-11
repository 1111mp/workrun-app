import { z } from '../../lib/zod';
import type { ApiProtocol } from './llm.schemas';

export const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(256) })),
});

export type TeamModel = {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'workrun';
  name: string;
  apiProtocols?: ApiProtocol[];
  capabilities?: {
    tools?: boolean;
    structuredOutput?: boolean;
    vision?: boolean;
    reasoningEfforts?: string[];
  };
};

// Parse only public capability fields; deployment params can contain credentials.
export const modelInfoSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string(),
      model_info: z
        .object({
          supports_function_calling: z.boolean().optional().catch(undefined),
          supports_response_schema: z.boolean().optional().catch(undefined),
          supports_vision: z.boolean().optional().catch(undefined),
          supported_endpoints: z.array(z.string()).optional().catch(undefined),
          supports_reasoning: z.boolean().optional().catch(undefined),
          supported_reasoning_efforts: z
            .array(z.string())
            .optional()
            .catch(undefined),
          reasoning_effort_levels: z
            .array(z.string())
            .optional()
            .catch(undefined),
        })
        .optional()
        .catch(undefined),
    }),
  ),
});

export type ModelInfo = z.infer<typeof modelInfoSchema>['data'][number];
const effortOrder = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const modelGroupSchema = z.object({
  data: z.array(
    z.object({
      model_group: z.string(),
      supported_reasoning_efforts: z
        .array(z.string())
        .optional()
        .catch(undefined),
    }),
  ),
});
export type ModelGroup = z.infer<typeof modelGroupSchema>['data'][number];

export function publicModel(
  id: string,
  entries: ModelInfo[],
  groups: ModelGroup[] = [],
): TeamModel {
  const capabilities: NonNullable<TeamModel['capabilities']> = {};
  for (const [field, source] of [
    ['tools', 'supports_function_calling'],
    ['structuredOutput', 'supports_response_schema'],
    ['vision', 'supports_vision'],
  ] as const) {
    const values = entries.map((entry) => entry.model_info?.[source]);
    // An alias may route to several deployments. Mixed/missing reports are unknown.
    if (values.length && values.every((value) => value === true))
      capabilities[field] = true;
    else if (values.length && values.every((value) => value === false))
      capabilities[field] = false;
  }
  const deploymentEfforts = entries.map(
    (entry) =>
      entry.model_info?.supported_reasoning_efforts ??
      entry.model_info?.reasoning_effort_levels,
  );
  const reported = groups
    .map((group) => group.supported_reasoning_efforts)
    .filter((values) => values !== undefined);
  // Only combine deployment reports if every routed deployment declares its levels.
  if (
    deploymentEfforts.length &&
    deploymentEfforts.every((values) => values !== undefined)
  )
    reported.push(...deploymentEfforts);
  if (reported.length) {
    capabilities.reasoningEfforts = effortOrder.filter(
      (effort) =>
        !entries.some(
          (entry) => entry.model_info?.supports_reasoning === false,
        ) && reported.every((levels) => levels.includes(effort)),
    );
  }
  const protocols = (['chat_completions', 'responses'] as const).filter(
    (protocol) =>
      entries.length &&
      entries.every((entry) =>
        entry.model_info?.supported_endpoints?.some(
          (endpoint) =>
            endpoint.replace(/^\/v1/, '') ===
            (protocol === 'responses' ? '/responses' : '/chat/completions'),
        ),
      ),
  );
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'workrun',
    name: id,
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(protocols.length ? { apiProtocols: protocols } : {}),
  };
}
