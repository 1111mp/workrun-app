import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

import { BetterAuthUser } from '../../user/schemas/better-auth-user.schema';

@Schema({ timestamps: true, versionKey: false })
export class App {
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

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ default: '0.1.0' })
  version!: string;

  @Prop({ default: 'main.py' })
  entry!: string;

  @Prop({ trim: true })
  projectRoot?: string;

  @Prop({ enum: ['workflow', 'tool'], default: 'workflow' })
  kind!: 'workflow' | 'tool';

  @Prop({ enum: ['ask_every_time', 'auto'], default: 'ask_every_time' })
  toolExecutionPolicy!: 'ask_every_time' | 'auto';

  @Prop({ enum: ['low', 'medium', 'high'], default: 'low' })
  toolRiskLevel!: 'low' | 'medium' | 'high';

  @Prop({ type: [String], default: [] })
  toolPermissions!: string[];

  @Prop({ type: Object, default: {} })
  inputs!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  outputs!: Record<string, unknown>;

  @Prop({ type: Boolean, default: false })
  isDelete!: boolean;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export type AppDocument = HydratedDocument<App>;

export const AppSchema = SchemaFactory.createForClass(App);

AppSchema.index({ ownerId: 1, isDelete: 1, updatedAt: -1 });
