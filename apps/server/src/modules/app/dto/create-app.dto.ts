import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateAppDto {
  @ApiProperty({ example: 'Process data' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'Transforms uploaded data.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '0.1.0', default: '0.1.0' })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({ example: 'main.py', default: 'main.py' })
  @IsOptional()
  @IsString()
  entry?: string;

  @ApiPropertyOptional({
    example: '/Users/me/projects/process-data',
    description: 'Absolute directory under which this App project is created.',
  })
  @IsOptional()
  @IsString()
  projectRoot?: string;

  @ApiPropertyOptional({ enum: ['workflow', 'tool'], default: 'workflow' })
  @IsOptional()
  @IsIn(['workflow', 'tool'])
  kind?: 'workflow' | 'tool';

  @ApiPropertyOptional({ enum: ['ask_every_time', 'auto'] })
  @IsOptional()
  @IsIn(['ask_every_time', 'auto'])
  toolExecutionPolicy?: 'ask_every_time' | 'auto';

  @ApiPropertyOptional({ enum: ['low', 'medium', 'high'] })
  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  toolRiskLevel?: 'low' | 'medium' | 'high';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolPermissions?: string[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  inputs?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  outputs?: Record<string, unknown>;
}
