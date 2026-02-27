import { Module } from '@nestjs/common';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentController } from './agent.controller';
import { ModelsModule } from '../models/models.module';
import { ToolsModule } from '../tools/tools.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [ModelsModule, ToolsModule, MemoryModule],
  controllers: [AgentController],
  providers: [AgentOrchestratorService],
  exports: [AgentOrchestratorService],
})
export class AgentModule {}
