import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { pick } from 'lodash-es';
import { HydratedDocument } from 'mongoose';

import type { FSMetaData } from '../types';

@Schema({ timestamps: true, versionKey: false })
export class MutableFS {
  @Prop({
    required: true,
    type: String,
  })
  bucketName!: string;

  @Prop({
    required: true,
    type: String,
  })
  filename!: string;

  @Prop({
    type: String,
  })
  scope!: string;

  @Prop({
    type: String,
  })
  contentType!: string;

  @Prop({
    type: String,
  })
  content!: string;

  @Prop({
    type: Number,
    default: 0,
  })
  size!: number;

  @Prop({
    type: Object,
  })
  extra!: Record<string, any>;
}

export type MutableFSDocument = HydratedDocument<
  MutableFS & { metadata: FSMetaData }
>;

export const MutableFSSchema = SchemaFactory.createForClass(MutableFS);

MutableFSSchema.virtual('metadata').get(function (this: MutableFSDocument) {
  return {
    ...pick(this, ['filename', 'scope', 'contentType', 'size', 'extra']),
    id: this._id.toString(),
  };
});

MutableFSSchema.index(
  { bucketName: 1, scope: 1, filename: 1 },
  { unique: true },
);
