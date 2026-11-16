import { Body, Controller, Get, Post, Res, SetMetadata } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import type { Response } from 'express';

import { OPENAI_RESPONSE } from '../../interceptors/resp-transform.interceptor';
import { LlmService } from './llm.service';

@ApiCookieAuth('sessionCookie')
@ApiBearerAuth('bearerAuth')
@SetMetadata(OPENAI_RESPONSE, true)
@Controller('llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @Get('models')
  @ApiOperation({ summary: 'List team models (OpenAI-compatible envelope)' })
  models() {
    return this.llm.models();
  }

  @Post('chat/completions')
  @ApiProduces('application/json', 'text/event-stream')
  @ApiOperation({
    summary:
      'Create a team chat completion; authenticated user attribution is server-owned',
  })
  chat(
    @Session() session: UserSession,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    return this.llm.chat(session?.user?.id, body, response);
  }

  @Post('responses')
  @ApiProduces('application/json', 'text/event-stream')
  @ApiOperation({
    summary:
      'Create a stateless team response; replay context in input (store=false)',
  })
  responses(
    @Session() session: UserSession,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    return this.llm.responses(session?.user?.id, body, response);
  }
}
