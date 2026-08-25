import { Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { Connection } from 'mongoose';

import { createAuth } from './lib/auth';
import { LoggerMiddleware } from './middlewares/logger.middleware';
import { AppModule } from './modules/app/app.module';
import { FileModule } from './modules/file/file.module';
import { UserModule } from './modules/user/user.module';

const envFilePath = ['.env'];
if (process.env.NODE_ENV === 'development') {
  envFilePath.unshift('.env.development');
} else {
  envFilePath.unshift('.env.production');
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get('MONGODB_URI'),
        retryAttempts: 10,
        retryDelay: 1000,
        autoIndex: true,
        autoCreate: true,
      }),
      inject: [ConfigService],
    }),

    AuthModule.forRootAsync({
      useFactory: (configService: ConfigService, connection: Connection) => ({
        auth: createAuth(configService, connection),
      }),
      inject: [ConfigService, getConnectionToken()],
    }),

    AppModule,
    UserModule,
    FileModule,
  ],
  providers: [Logger],
})
export class MainModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*path');
  }
}
