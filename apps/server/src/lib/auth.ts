import { ConfigService } from '@nestjs/config';
import { betterAuth } from 'better-auth';
import { mongooseAdapter } from 'better-auth-mongoose';
import { openAPI } from 'better-auth/plugins';
import type { Connection } from 'mongoose';

export function createAuth(
  configService: ConfigService,
  connection: Connection,
) {
  const auth = betterAuth({
    baseURL: configService.get<string>('BETTER_AUTH_URL'),
    basePath: 'api/v1/auth',
    database: mongooseAdapter(connection),
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
    plugins: [openAPI({ disableDefaultReference: true })],
  });

  return auth;
}
