import { Module } from '@nestjs/common';

import { FSModule } from '../fs/fs.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';

@Module({
  imports: [FSModule],
  controllers: [FileController],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
