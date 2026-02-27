import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuid } from 'uuid';
import {
  AgentTask,
  AgentStep,
  TaskStatus,
  TaskContext,
  StepType,
  ModelProvider,
} from '../common/interfaces/agent.types';
import { ModelRouterService } from '../models/model-router.service';
import { ModelClientService, CompletionRequest } from '../models/model-client.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { MemoryService } from '../memory/memory.service';

/**
 * AgentOrchestratorService
 *
 * The brain of the system. Implements the ReACT loop:
 *   1. THOUGHT  — LLM reasons about what to do next
 *   2. ACTION   — LLM decides on a tool call (or final answer)
 *   3. OBSERVATION — Tool executes, result fed back to LLM
 *   4. Repeat until FINAL_ANSWER or max iterations
 *
 * Inspired by MiniMax Agent's multi-step planning, but fully
 * self-hosted with transparent routing between local + Claude.
 */
@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  /** Active tasks for kill-switch support */
  private readonly activeTasks = new Map<string, { cancelled: boolean }>();

  constructor(
    private readonly router: ModelRouterService,
    private readonly modelClient: ModelClientService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly memory: MemoryService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Execute an agent task from start to finish.
   * Returns the completed task with full step history.
   */
  async executeTask(
    input: string,
    context: Partial<TaskContext> = {},
  ): Promise<AgentTask> {
    const taskCtx: TaskContext = {
      maxIterations: context.maxIterations ?? 15,
      allowedTools: context.allowedTools ?? ['*'],
      ...context,
    };

    // Route to best model
    const routing = this.router.route(
      input,
      taskCtx.allowedTools.includes('*')
        ? this.toolRegistry.getDefinitions().map(t => t.name)
        : taskCtx.allowedTools,
    );

    // Initialize task
    const task: AgentTask = {
      id: uuid(),
      input,
      status: TaskStatus.PLANNING,
      complexity: routing.complexity,
      steps: [],
      context: taskCtx,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.activeTasks.set(task.id, { cancelled: false });
    await this.memory.saveTask(task);

    this.eventEmitter.emit('task.started', {
      taskId: task.id,
      complexity: routing.complexity,
      provider: routing.provider,
    });

    this.logger.log(
      `Task ${task.id} started → ${routing.provider}/${routing.model} ` +
      `[${routing.complexity}] "${input.slice(0, 80)}..."`,
    );

    try {
      await this.runReactLoop(task, routing.provider);
    } catch (error) {
      task.status = TaskStatus.FAILED;
      task.finalAnswer = `Agent error: ${error.message}`;
      this.logger.error(`Task ${task.id} failed: ${error.message}`);
    } finally {
      task.updatedAt = new Date();
      task.completedAt = new Date();
      this.activeTasks.delete(task.id);
      await this.memory.saveTask(task);

      this.eventEmitter.emit('task.completed', {
        taskId: task.id,
        status: task.status,
        steps: task.steps.length,
      });
    }

    return task;
  }

  /**
   * Cancel a running task.
   */
  cancelTask(taskId: string): boolean {
    const handle = this.activeTasks.get(taskId);
    if (handle) {
      handle.cancelled = true;
      return true;
    }
    return false;
  }

  // ── ReACT Loop ─────────────────────────────────────────────

  private async runReactLoop(
    task: AgentTask,
    provider: ModelProvider,
  ): Promise<void> {
    task.status = TaskStatus.EXECUTING;

    for (let i = 0; i < task.context.maxIterations; i++) {
      // Check kill switch
      if (this.activeTasks.get(task.id)?.cancelled) {
        task.status = TaskStatus.CANCELLED;
        task.finalAnswer = 'Task cancelled by user.';
        return;
      }

      const systemPrompt = this.buildSystemPrompt(task);
      const messages = this.buildMessages(task);

      // Get LLM response
      const start = Date.now();
      const response = await this.modelClient.complete(provider, {
        systemPrompt,
        messages,
        tools: this.toolRegistry.getFilteredDefinitions(task.context.allowedTools),
        temperature: 0.3,
      });
      const latencyMs = Date.now() - start;

      // ── Handle tool calls ──
      if (response.toolCalls?.length) {
        for (const toolCall of response.toolCalls) {
          // Record the thought + action
          const thoughtStep: AgentStep = {
            id: uuid(),
            type: StepType.THOUGHT,
            content: response.content || `Deciding to use tool: ${toolCall.name}`,
            model: provider,
            tokenUsage: response.tokenUsage,
            latencyMs,
            timestamp: new Date(),
          };
          task.steps.push(thoughtStep);

          const actionStep: AgentStep = {
            id: uuid(),
            type: StepType.ACTION,
            content: `Calling ${toolCall.name}`,
            toolCall: {
              toolName: toolCall.name,
              arguments: toolCall.arguments,
            },
            model: provider,
            tokenUsage: { input: 0, output: 0 },
            latencyMs: 0,
            timestamp: new Date(),
          };
          task.steps.push(actionStep);

          // Execute the tool
          task.status = TaskStatus.AWAITING_TOOL;
          const toolResult = await this.toolRegistry.execute({
            toolName: toolCall.name,
            arguments: toolCall.arguments,
          });

          // Record observation
          const observationStep: AgentStep = {
            id: uuid(),
            type: StepType.OBSERVATION,
            content: toolResult.success
              ? toolResult.output
              : `Error: ${toolResult.error}`,
            toolResult,
            model: provider,
            tokenUsage: { input: 0, output: 0 },
            latencyMs: toolResult.executionTimeMs,
            timestamp: new Date(),
          };
          task.steps.push(observationStep);
          task.status = TaskStatus.EXECUTING;

          // Audit log
          await this.memory.logAudit({
            id: uuid(),
            taskId: task.id,
            action: `tool:${toolCall.name}`,
            details: {
              arguments: toolCall.arguments,
              success: toolResult.success,
              output: toolResult.output.slice(0, 500),
            },
            timestamp: new Date(),
            provider,
            toolName: toolCall.name,
          });
        }

        // Save progress
        await this.memory.saveTask(task);
        continue; // Next iteration of the loop
      }

      // ── Handle final answer (no tool calls) ──
      if (response.content && !response.toolCalls?.length) {
        const finalStep: AgentStep = {
          id: uuid(),
          type: StepType.FINAL,
          content: response.content,
          model: provider,
          tokenUsage: response.tokenUsage,
          latencyMs,
          timestamp: new Date(),
        };
        task.steps.push(finalStep);
        task.finalAnswer = response.content;
        task.status = TaskStatus.COMPLETED;
        return;
      }
    }

    // Hit max iterations
    task.status = TaskStatus.COMPLETED;
    task.finalAnswer =
      task.steps.length > 0
        ? `Reached max iterations (${task.context.maxIterations}). ` +
          `Last observation: ${task.steps[task.steps.length - 1].content.slice(0, 300)}`
        : 'Task could not be completed within iteration limits.';
  }

  // ── Prompt Construction ────────────────────────────────────

  private buildSystemPrompt(task: AgentTask): string {
    const tools = this.toolRegistry.getFilteredDefinitions(task.context.allowedTools);
    const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    return `You are WillAgent, an autonomous AI assistant with access to tools.

Your task: Complete the user's request by reasoning step-by-step and using tools when needed.

## Available Tools
${toolList}

## Instructions
1. Think through what you need to do
2. If you need information or need to perform an action, use the appropriate tool
3. After receiving tool results, reason about what to do next
4. When you have enough information to answer, provide your final response directly (without calling a tool)

## Rules
- Be concise and precise in tool arguments
- If a tool fails, try an alternative approach
- Never fabricate tool results — only use actual observations
- If you cannot complete the task, explain what went wrong
- Iteration limit: ${task.context.maxIterations} steps

Current task ID: ${task.id}`;
  }

  private buildMessages(
    task: AgentTask,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Initial user request
    messages.push({ role: 'user', content: task.input });

    // Replay step history as conversation turns
    for (const step of task.steps) {
      switch (step.type) {
        case StepType.THOUGHT:
        case StepType.ACTION:
          // These are assistant turns
          messages.push({ role: 'assistant', content: step.content });
          break;
        case StepType.OBSERVATION:
          // Tool results come back as user messages (observation)
          messages.push({
            role: 'user',
            content: `[Tool Result]: ${step.content}`,
          });
          break;
      }
    }

    return messages;
  }
}
