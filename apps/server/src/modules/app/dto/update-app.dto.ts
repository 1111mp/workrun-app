import { OmitType, PartialType } from '@nestjs/swagger';

import { CreateAppDto } from './create-app.dto';

export class UpdateAppDto extends PartialType(
  OmitType(CreateAppDto, ['id'] as const),
) {}
