import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, IsNumber, Max, Min } from 'class-validator';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { MemoryService } from '../memory/memory.service';

// ── DTOs ─────────────────────────────────────────────────────

export class CreateTaskDto {
  @IsString()
  input: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  maxIterations?: number;
}

// ── Controller ───────────────────────────────────────────────

@ApiTags('agent')
@Controller('api/v1/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly orchestrator: AgentOrchestratorService,
    private readonly memory: MemoryService,
  ) {}

  @Post('task')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit a new agent task' })
  @ApiResponse({ status: 200, description: 'Task completed' })
  async createTask(@Body() dto: CreateTaskDto) {
    this.logger.log(`New task: "${dto.input.slice(0, 80)}..."`);

    const task = await this.orchestrator.executeTask(dto.input, {
      conversationId: dto.conversationId,
      allowedTools: dto.allowedTools ?? ['*'],
      maxIterations: dto.maxIterations ?? 15,
    });

    return {
      id: task.id,
      status: task.status,
      answer: task.finalAnswer,
      complexity: task.complexity,
      steps: task.steps.length,
      timing: {
        created: task.createdAt,
        completed: task.completedAt,
        totalMs: task.completedAt
          ? new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()
          : null,
      },
      // Include full step trace for debugging
      trace: task.steps.map(s => ({
        type: s.type,
        content: s.content.slice(0, 500),
        tool: s.toolCall?.toolName,
        model: s.model,
        latencyMs: s.latencyMs,
        tokens: s.tokenUsage,
      })),
    };
  }

  @Get('task/:id')
  @ApiOperation({ summary: 'Get task status and results' })
  async getTask(@Param('id') id: string) {
    const task = await this.memory.getTask(id);
    if (!task) {
      return { error: 'Task not found', id };
    }
    return task;
  }

  @Delete('task/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running task' })
  async cancelTask(@Param('id') id: string) {
    const cancelled = this.orchestrator.cancelTask(id);
    return { id, cancelled };
  }

  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  healthCheck() {
    return {
      status: 'ok',
      service: 'willagent',
      timestamp: new Date().toISOString(),
      tools: 'operational',
    };
  }
}
