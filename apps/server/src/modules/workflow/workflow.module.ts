import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UserModule } from '../user/user.module';
import {
  WorkflowRelease,
  WorkflowReleaseSchema,
} from './schemas/workflow-release.schema';
import { Workflow, WorkflowSchema } from './schemas/workflow.schema';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Workflow.name, schema: WorkflowSchema },
      { name: WorkflowRelease.name, schema: WorkflowReleaseSchema },
    ]),
    UserModule,
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
