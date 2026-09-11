import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FSModule } from '../fs/fs.module';
import { UserModule } from '../user/user.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppResource, AppResourceSchema } from './schemas/app-resource.schema';
import { AppVersion, AppVersionSchema } from './schemas/app-version.schema';
import { App, AppSchema } from './schemas/app.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: App.name, schema: AppSchema },
      { name: AppVersion.name, schema: AppVersionSchema },
      { name: AppResource.name, schema: AppResourceSchema },
    ]),
    FSModule,
    UserModule,
  ],
  controllers: [AppController],
  providers: [AppService],
  exports: [AppService],
})
export class AppModule {}
