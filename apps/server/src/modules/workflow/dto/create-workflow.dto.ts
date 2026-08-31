import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDefined, IsObject, ValidateNested } from 'class-validator';

class WorkflowDocumentDto {
  @IsDefined()
  @IsArray()
  nodes!: unknown[];

  @IsDefined()
  @IsArray()
  edges!: unknown[];

  @IsDefined()
  @IsObject()
  settings!: Record<string, unknown>;
}

export class CreateWorkflowDto {
  @ApiProperty({
    example: {
      nodes: [],
      edges: [],
      settings: {
        name: 'Customer support',
        mode: 'task',
        inputSchema: { fields: [] },
      },
    },
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => WorkflowDocumentDto)
  document!: WorkflowDocumentDto;
}
