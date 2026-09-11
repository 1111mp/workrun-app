import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class PublishWorkflowDto {
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
