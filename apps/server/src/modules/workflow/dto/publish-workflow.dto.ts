import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  IsOptional,
  ValidateNested,
} from 'class-validator';

import { WorkflowDocumentDto } from './create-workflow.dto';

export class PublishWorkflowDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowDocumentDto)
  document?: WorkflowDocumentDto;

  @ApiProperty({ example: '1.2.3' })
  @IsString()
  @Matches(
    /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  version!: string;

  @ApiProperty({ example: 'Add customer escalation path.' })
  @IsString()
  @IsNotEmpty()
  releaseNote!: string;
}
