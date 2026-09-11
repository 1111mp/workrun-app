import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, versionKey: false })
export class AppVersion {
  @Prop({ required: true, unique: true, immutable: true })
  id!: string;

  @Prop({ required: true, index: true, immutable: true })
  appId!: string;

  @Prop({ required: true, immutable: true })
  version!: string;

  @Prop({ required: true, immutable: true })
  releaseNote!: string;

  @Prop({ enum: ['uploading', 'published'], default: 'uploading' })
  status!: 'uploading' | 'published';

  // The App can change after publication, so every release owns its snapshot.
  @Prop({ type: Object, required: true, immutable: true })
  definition!: Record<string, unknown>;

  @Prop({ type: Date, default: null })
  publishedAt?: Date | null;
}

export const AppVersionSchema = SchemaFactory.createForClass(AppVersion);

export type AppVersionDocument = HydratedDocument<AppVersion>;

AppVersionSchema.index({ appId: 1, version: 1 }, { unique: true });
