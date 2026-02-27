import { Module } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { ModelClientService } from './model-client.service';

@Module({
  providers: [ModelRouterService, ModelClientService],
  exports: [ModelRouterService, ModelClientService],
})
export class ModelsModule {}
