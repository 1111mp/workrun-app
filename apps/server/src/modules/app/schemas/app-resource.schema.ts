import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, versionKey: false })
export class AppResource {
  @Prop({ required: true, unique: true, immutable: true })
  id!: string;

  @Prop({ required: true, index: true, immutable: true })
  appVersionId!: string;

  @Prop({ enum: ['source_archive'], required: true, immutable: true })
  kind!: 'source_archive';

  @Prop({ required: true, immutable: true })
  fileId!: string;

  @Prop({ required: true, immutable: true })
  filename!: string;

  @Prop({ required: true, immutable: true })
  format!: 'tar.gz';

  @Prop({ required: true, immutable: true })
  sha256!: string;

  @Prop({ required: true, immutable: true })
  size!: number;

  @Prop({ immutable: true })
  url?: string;
}

export const AppResourceSchema = SchemaFactory.createForClass(AppResource);

export type AppResourceDocument = HydratedDocument<AppResource>;

AppResourceSchema.index({ appVersionId: 1, kind: 1 }, { unique: true });
