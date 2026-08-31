import { PartialType } from '@nestjs/swagger';

import { CreateAppDto } from './create-app.dto';

export class UpdateAppDto extends PartialType(CreateAppDto) {}
