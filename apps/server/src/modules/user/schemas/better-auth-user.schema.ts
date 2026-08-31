import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

/** Read-only Mongoose view of Better Auth's `user` collection. */
@Schema({ collection: 'user', strict: false, versionKey: false })
export class BetterAuthUser {
  /** Better Auth's logical `id` is stored as MongoDB `_id`. */
  _id!: Types.ObjectId;

  @Prop({ type: String })
  name!: string;

  @Prop({ type: String })
  email!: string;

  @Prop({ type: Boolean })
  emailVerified!: boolean;

  @Prop({ type: String })
  image?: string | null;

  @Prop({ type: Date })
  createdAt!: Date;

  @Prop({ type: Date })
  updatedAt!: Date;
}

export type BetterAuthUserDocument = HydratedDocument<BetterAuthUser>;

export const BetterAuthUserSchema =
  SchemaFactory.createForClass(BetterAuthUser);
