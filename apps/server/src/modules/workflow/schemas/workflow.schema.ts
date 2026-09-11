import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

import { BetterAuthUser } from '../../user/schemas/better-auth-user.schema';
import { WorkflowRelease } from './workflow-release.schema';

@Schema({ timestamps: true, versionKey: false })
export class Workflow {
  // Added by Mongoose because this schema enables `timestamps`.
  createdAt!: Date;

  updatedAt!: Date;

  @Prop({ required: true, unique: true, immutable: true })
  id!: string;

  @Prop({
    required: true,
    index: true,
    immutable: true,
    type: Types.ObjectId,
    ref: BetterAuthUser.name,
  })
  ownerId!: Types.ObjectId | BetterAuthUser;

  @Prop({ required: true, type: Object })
  document!: {
    nodes: unknown[];
    edges: unknown[];
    settings: Record<string, unknown>;
  };

  @Prop({ enum: ['draft', 'published'], default: 'draft' })
  status!: 'draft' | 'published';

  @Prop({ type: Types.ObjectId, ref: WorkflowRelease.name, default: null })
  latestReleaseId?: Types.ObjectId | WorkflowRelease | null;

  @Prop({ type: Boolean, default: false })
  isDelete!: boolean;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export type WorkflowDocument = HydratedDocument<Workflow>;

export const WorkflowSchema = SchemaFactory.createForClass(Workflow);

WorkflowSchema.index({ ownerId: 1, isDelete: 1, updatedAt: -1 });
