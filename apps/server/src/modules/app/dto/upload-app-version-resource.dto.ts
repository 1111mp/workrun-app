import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

export class UploadAppVersionResourceDto {
  @ApiProperty({ enum: ['tar.gz'] })
  @IsIn(['tar.gz'])
  format!: 'tar.gz';

  @ApiProperty({
    description: 'SHA-256 digest of the uploaded archive in lowercase hex.',
  })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sha256!: string;
}
