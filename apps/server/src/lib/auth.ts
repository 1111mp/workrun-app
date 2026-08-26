import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { tauri } from '@daveyplate/better-auth-tauri/plugin';
import { ConfigService } from '@nestjs/config';
import { betterAuth } from 'better-auth';
import { openAPI } from 'better-auth/plugins';
import type { Connection } from 'mongoose';

export function createAuth(
  configService: ConfigService,
  connection: Connection,
) {
  const baseURL = configService.get<string>('BETTER_AUTH_URL');
  const client = connection.getClient();
  const auth = betterAuth({
    baseURL,
    basePath: '/api/v1/auth',
    database: mongodbAdapter(client.db(), {
      client,
      transaction: false,
    }),
    advanced: {
      database: {
        joins: true,
      },
    },
    emailAndPassword: {
      enabled: true,
    },
    secret:
      configService.get<string>('BETTER_AUTH_SECRET') ??
      'example-only-secret-do-not-use-in-production-32',
    socialProviders: {
      github: {
        clientId: configService.get<string>('GITHUB_CLIENT_ID')!,
        clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET')!,
      },
    },
    trustedOrigins: [
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://localhost:1420',
    ],
    plugins: [
      tauri({
        callbackURL: '/workflows',
        debugLogs: process.env.NODE_ENV === 'development',
        scheme: 'workrun',
      }),
      openAPI({ disableDefaultReference: true }),
    ],
  });

  return auth;
}
