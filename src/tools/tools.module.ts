import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ShellTool, WebFetchTool, JsonTransformTool } from '../tools/builtin-tools';

@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [
    ToolRegistryService,
    ShellTool,
    WebFetchTool,
    JsonTransformTool,
  ],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
