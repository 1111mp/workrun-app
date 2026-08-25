import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';

import { AllExceptionsFilter } from './filters/all-exception.filter';
import { RespTransformInterceptor } from './interceptors/resp-transform.interceptor';
import { createLogger } from './logger';
import { MainModule } from './main.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(MainModule, {
    bodyParser: false, // Required for Better Auth
    logger: createLogger(),
  });

  const configService = app.get(ConfigService);
  const logger = app.get(Logger);

  const port = configService.get<number>('SERVER_PORT');

  // api version
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    prefix: false,
    defaultVersion: 'v1',
  });

  // Setting up a trusted reverse proxy.
  // If true, the client’s IP address is understood as the left-most entry in the X-Forwarded-For header.
  app.set('trust proxy', true);

  app.enableCors({
    origin: [/localhost:\d+$/],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 3600,
  });

  app.disable('etag');

  app.useBodyParser('json', { limit: '20mb' });
  app.useBodyParser('raw', { limit: '200mb' });

  /**
   * The extended option is set to true, which means that the URL-encoded data will be parsed with the qs library,
   * allowing for rich objects and arrays to be encoded into the URL-encoded format.
   *
   * If you set extended to false, it will use the querystring library for parsing, which does not support nested objects.
   */
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalInterceptors(new RespTransformInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  // swagger openapi
  const options = new DocumentBuilder()
    .setTitle('Workrun Server')
    .setDescription(
      'Workrun backend API server built with NestJS, MongoDB, and Better Auth.',
    )
    .setVersion('1.0')
    .addServer(`${configService.get<string>('SERVER_BASE_URL')}`)
    .addCookieAuth(
      'better-auth.session_token',
      {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
        description: 'Better Auth session cookie',
      },
      'sessionCookie',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: 'Better Auth bearer token',
      },
      'bearerAuth',
    )
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('api/docs', app, documentFactory, {
    explorer: true,
    swaggerOptions: {
      urls: [
        { name: 'Workrun API', url: '/api/docs-json' },
        {
          name: 'Better Auth API',
          url: '/api/v1/auth/open-api/generate-schema',
        },
      ],
    },
  });

  await app.listen(port ?? 3000);

  logger.log(`Application is running on: ${await app.getUrl()}`);
}

bootstrap();
