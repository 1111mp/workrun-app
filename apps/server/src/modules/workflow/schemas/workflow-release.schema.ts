import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, versionKey: false })
export class WorkflowRelease {
  @Prop({ required: true, unique: true, immutable: true })
  id!: string;

  @Prop({ required: true, index: true, immutable: true })
  workflowId!: string;

  @Prop({ required: true, immutable: true })
  version!: string;

  @Prop({ required: true, immutable: true })
  releaseNote!: string;

  // A release must be runnable even after the owner edits the next draft.
  @Prop({ type: Object, required: true, immutable: true })
  document!: {
    nodes: unknown[];
    edges: unknown[];
    settings: Record<string, unknown>;
  };

  @Prop({ type: Date, required: true, immutable: true })
  publishedAt!: Date;
}

export type WorkflowReleaseDocument = HydratedDocument<WorkflowRelease>;

export const WorkflowReleaseSchema =
  SchemaFactory.createForClass(WorkflowRelease);

WorkflowReleaseSchema.index({ workflowId: 1, version: 1 }, { unique: true });
