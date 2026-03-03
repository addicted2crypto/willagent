import { Module } from '@nestjs/common';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentController } from './agent.controller';
import { CommandParserService } from './command-parser.service';
import { ModelsModule } from '../models/models.module';
import { ToolsModule } from '../tools/tools.module';
import { MemoryModule } from '../memory/memory.module';
import { AvaxModule } from '../avax/avax.module';

@Module({
  imports: [ModelsModule, ToolsModule, MemoryModule, AvaxModule],
  controllers: [AgentController],
  providers: [AgentOrchestratorService, CommandParserService],
  exports: [AgentOrchestratorService, CommandParserService],
})
export class AgentModule {}
