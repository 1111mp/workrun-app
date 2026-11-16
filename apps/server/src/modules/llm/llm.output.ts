import type { InferenceParameters } from './llm.schemas';

// JSON mode constrains syntax only. Keep the schema in the instructions so
// callers can still parse and validate the expected structure locally.
export function adaptJsonOutput(
  parameters: InferenceParameters,
  aliases: string,
): InferenceParameters {
  if (
    !aliases
      .split(',')
      .map((alias) => alias.trim())
      .includes(parameters.model)
  )
    return parameters;

  if ('messages' in parameters) {
    const format = parameters.response_format as
      | { type?: string; json_schema?: { schema?: unknown } }
      | undefined;
    if (format?.type !== 'json_schema' || !format.json_schema?.schema)
      return parameters;
    return {
      ...parameters,
      response_format: { type: 'json_object' },
      messages: [
        ...parameters.messages,
        { role: 'system', content: instruction(format.json_schema.schema) },
      ],
    };
  }

  const text = parameters.text as
    | { format?: { type?: string; schema?: unknown } }
    | undefined;
  if (text?.format?.type !== 'json_schema' || !text.format.schema)
    return parameters;
  return {
    ...parameters,
    text: { ...text, format: { type: 'json_object' } },
    instructions: [parameters.instructions, instruction(text.format.schema)]
      .filter(Boolean)
      .join('\n\n'),
  };
}

function instruction(schema: unknown): string {
  return `Return only a JSON object conforming to this JSON Schema:\n${JSON.stringify(schema)}`;
}
