import { Transform, TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// LiteLLM can emit usage with a placeholder choice instead of choices: [].
// OpenAI-compatible clients (including ADK) otherwise ignore that usage tail.
function normalizeFrame(frame: string): string {
  const match = frame.match(/^data: (.+)$/m);
  if (!match || match[1] === '[DONE]') return frame;
  try {
    const value = JSON.parse(match[1]);
    if (
      value.usage &&
      Array.isArray(value.choices) &&
      value.choices.length > 0 &&
      value.choices.every(
        (choice: { delta?: object; finish_reason?: string | null }) =>
          choice.finish_reason == null &&
          choice.delta != null &&
          Object.keys(choice.delta).length === 0,
      )
    ) {
      return frame.replace(
        match[0],
        `data: ${JSON.stringify({ ...value, choices: [] })}`,
      );
    }
  } catch {
    // Forward non-JSON SSE data unchanged; the provider client owns validation.
  }
  return frame;
}

export class ChatUsageStream extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    this.pending += this.decoder.write(chunk);
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(this.pending))) {
      const end = separator.index + separator[0].length;
      this.push(normalizeFrame(this.pending.slice(0, end)));
      this.pending = this.pending.slice(end);
    }
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(normalizeFrame(this.pending + this.decoder.end()));
    callback();
  }
}
