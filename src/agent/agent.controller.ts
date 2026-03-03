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
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, IsNumber, Max, Min } from 'class-validator';
import { Observable, Subject, filter, map } from 'rxjs';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { MemoryService } from '../memory/memory.service';
import { AvaxRpcService } from '../avax/services/avax-rpc.service';

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

interface ProgressEvent {
  taskId: string;
  step: string;
  message: string;
  progress: number;
}

@ApiTags('agent')
@Controller('api/v1/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);
  private readonly progressSubject = new Subject<ProgressEvent>();

  constructor(
    private readonly orchestrator: AgentOrchestratorService,
    private readonly memory: MemoryService,
    private readonly eventEmitter: EventEmitter2,
    private readonly avaxRpc: AvaxRpcService,
  ) {
    // Listen for progress events from services
    this.eventEmitter.on('task.progress', (event: ProgressEvent) => {
      this.progressSubject.next(event);
    });
  }

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
  async healthCheck() {
    // Quick RPC test to verify endpoints
    let blockNumber: number | null = null;
    let rpcStatus = 'unknown';
    try {
      blockNumber = await this.avaxRpc.getBlockNumber();
      rpcStatus = 'ok';
    } catch {
      rpcStatus = 'error';
    }

    return {
      status: 'ok',
      service: 'willagent',
      timestamp: new Date().toISOString(),
      tools: 'operational',
      rpc: {
        status: rpcStatus,
        blockNumber,
        endpointWins: this.avaxRpc.getEndpointStats(),
      },
    };
  }

  @Sse('task/:id/stream')
  @ApiOperation({ summary: 'Stream task progress via SSE' })
  streamTaskProgress(@Param('id') id: string): Observable<MessageEvent> {
    this.logger.log(`SSE connection opened for task ${id}`);

    return this.progressSubject.pipe(
      filter((event) => event.taskId === id),
      map((event) => ({
        data: JSON.stringify({
          step: event.step,
          message: event.message,
          progress: event.progress,
        }),
      })),
    );
  }

  @Get('progress/all')
  @ApiOperation({ summary: 'Stream all progress events (debug)' })
  @Sse()
  streamAllProgress(): Observable<MessageEvent> {
    return this.progressSubject.pipe(
      map((event) => ({
        data: JSON.stringify(event),
      })),
    );
  }
}
