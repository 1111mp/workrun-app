import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Connection, type Model } from 'mongoose';

import { MutableFSService } from './fs-mutable.service';
import { StaticFSService } from './fs-static.service';
import { FS_MUTABLE_SERVICE, FS_STATIC_SERVICE } from './fs.constant';
import {
  MutableFS,
  MutableFSSchema,
  type MutableFSDocument,
} from './schemas/mutable-fs.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MutableFS.name, schema: MutableFSSchema },
    ]),
  ],
  providers: [
    {
      provide: FS_STATIC_SERVICE,
      useFactory: (configService: ConfigService, connection: Connection) => {
        return new StaticFSService(
          connection,
          'static',
          false,
          `${configService.get<string>('SERVER_BASE_URL')}/v1/api/file/static`,
        );
      },
      inject: [ConfigService, getConnectionToken()],
    },
    {
      provide: FS_MUTABLE_SERVICE,
      useFactory: (mutableFSModel: Model<MutableFSDocument>) => {
        return new MutableFSService(mutableFSModel, 'mutable');
      },
      inject: [getModelToken(MutableFS.name)],
    },
  ],
  exports: [FS_STATIC_SERVICE, FS_MUTABLE_SERVICE],
})
export class FSModule {}
