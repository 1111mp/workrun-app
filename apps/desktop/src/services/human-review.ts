import { artifactReferences } from './artifact';

/** Older durable review requests have resources inside content/context only. */
export function humanReviewAttachments(payload: Record<string, unknown>) {
  return artifactReferences({
    attachments: payload.attachments,
    content: payload.content,
    context: payload.context,
  });
}
