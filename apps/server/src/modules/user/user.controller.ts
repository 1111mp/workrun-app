import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth } from '@nestjs/swagger';
import {
  AllowAnonymous,
  OptionalAuth,
  Session,
  type UserSession,
} from '@thallesp/nestjs-better-auth';

@Controller('users')
export class UserController {
  @ApiCookieAuth('sessionCookie')
  @ApiBearerAuth('bearerAuth')
  @Get('me')
  async getProfile(@Session() session: UserSession) {
    return { user: session.user };
  }

  @Get('public')
  @AllowAnonymous() // Allow anonymous access
  async getPublic() {
    return { message: 'Public route' };
  }

  @Get('optional')
  @OptionalAuth() // Authentication is optional
  async getOptional(@Session() session: UserSession) {
    return { authenticated: !!session };
  }
}
