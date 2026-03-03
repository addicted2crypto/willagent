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
import { CommandParserService } from './command-parser.service';

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
    private readonly commandParser: CommandParserService,
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
      // ── Direct Command Execution ──
      // Check if this is a recognizable command pattern that can skip LLM
      const directCommand = this.commandParser.parse(input);

      if (directCommand) {
        this.logger.log(`Direct command detected: ${directCommand.tool}.${directCommand.action}`);
        await this.executeDirectCommand(task, directCommand);
      } else {
        // Fall back to full ReACT loop
        await this.runReactLoop(task, routing.provider);
      }
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

          // Execute the tool (inject taskId so tools can emit progress events)
          task.status = TaskStatus.AWAITING_TOOL;
          const toolResult = await this.toolRegistry.execute({
            toolName: toolCall.name,
            arguments: { ...toolCall.arguments, _taskId: task.id },
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
        // Validate answer quality - log if suspicious
        const isSuspicious =
          response.content.length < 50 ||
          response.content.toLowerCase().includes('deciding to use tool') ||
          response.content.toLowerCase().includes('i will use') ||
          response.content.toLowerCase().startsWith('tool:');

        if (isSuspicious) {
          this.logger.warn(`Task ${task.id} got suspicious final answer: "${response.content.slice(0, 100)}"`);
        }

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

  // ── Direct Command Execution ────────────────────────────────

  /**
   * Execute a parsed command directly without LLM reasoning.
   * This provides fast, predictable execution for common operations.
   */
  private async executeDirectCommand(
    task: AgentTask,
    command: { tool: string; action: string; args: Record<string, unknown>; raw: string },
  ): Promise<void> {
    task.status = TaskStatus.EXECUTING;

    // Handle built-in "help" command
    if (command.tool === 'help') {
      const helpText = `
═══════════════════════════════════════════════════════
 WILLAGENT COMMANDS
═══════════════════════════════════════════════════════

 CLUSTER ANALYSIS (find related wallets):
   <address>                    → Analyze wallet, find alts
   cluster vroshi55              → Analyze known wallet by name
   0x... tag as "whale1"        → Analyze + save with tag

 WALLET TRACKING:
   track 0x... as "name"        → Track wallet with tag
   list                         → Show tracked wallets

 VIEW CLUSTERS:
   view <name>                  → Show cluster by name

 EXAMPLES:
   0x168e8d263634ef25ef84a643d231ae39ceb75909 tag vroshi55
   cluster hashcash
   view vroshi55
   list

═══════════════════════════════════════════════════════
      `.trim();

      task.finalAnswer = helpText;
      task.status = TaskStatus.COMPLETED;
      task.steps.push({
        id: uuid(),
        type: StepType.FINAL,
        content: helpText,
        model: 'DIRECT' as ModelProvider,
        tokenUsage: { input: 0, output: 0 },
        latencyMs: 0,
        timestamp: new Date(),
      });
      return;
    }

    // Record the direct action
    const actionStep: AgentStep = {
      id: uuid(),
      type: StepType.ACTION,
      content: `Direct command: ${command.tool}.${command.action}`,
      toolCall: {
        toolName: command.tool,
        arguments: command.args,
      },
      model: 'DIRECT' as ModelProvider,
      tokenUsage: { input: 0, output: 0 },
      latencyMs: 0,
      timestamp: new Date(),
    };
    task.steps.push(actionStep);

    // Execute the tool
    task.status = TaskStatus.AWAITING_TOOL;
    const toolResult = await this.toolRegistry.execute({
      toolName: command.tool,
      arguments: { ...command.args, _taskId: task.id },
    });

    // Record observation
    const observationStep: AgentStep = {
      id: uuid(),
      type: StepType.OBSERVATION,
      content: toolResult.success ? toolResult.output : `Error: ${toolResult.error}`,
      toolResult,
      model: 'DIRECT' as ModelProvider,
      tokenUsage: { input: 0, output: 0 },
      latencyMs: toolResult.executionTimeMs,
      timestamp: new Date(),
    };
    task.steps.push(observationStep);

    // Use tool output as final answer
    const finalStep: AgentStep = {
      id: uuid(),
      type: StepType.FINAL,
      content: toolResult.success ? toolResult.output : `Error: ${toolResult.error}`,
      model: 'DIRECT' as ModelProvider,
      tokenUsage: { input: 0, output: 0 },
      latencyMs: 0,
      timestamp: new Date(),
    };
    task.steps.push(finalStep);

    task.finalAnswer = finalStep.content;
    task.status = toolResult.success ? TaskStatus.COMPLETED : TaskStatus.FAILED;

    // Audit log
    await this.memory.logAudit({
      id: uuid(),
      taskId: task.id,
      action: `direct:${command.tool}.${command.action}`,
      details: {
        command: command.raw,
        arguments: command.args,
        success: toolResult.success,
      },
      timestamp: new Date(),
      provider: 'DIRECT' as ModelProvider,
      toolName: command.tool,
    });
  }

  // ── Prompt Construction ────────────────────────────────────

  private buildSystemPrompt(task: AgentTask): string {
    const tools = this.toolRegistry.getFilteredDefinitions(task.context.allowedTools);
    const toolList = tools.map(t => {
      const schema = t.inputSchema as { properties?: Record<string, unknown> };
      const params = schema?.properties ? Object.keys(schema.properties).join(', ') : '';
      return `- ${t.name}(${params}): ${t.description}`;
    }).join('\n');

    const toolSchemas = tools.map(t => {
      return `### ${t.name}\n\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``;
    }).join('\n\n');

    return `You are WillAgent, an autonomous AI assistant with access to tools.

Your task: Complete the user's request by reasoning step-by-step and using tools when needed.

## Available Tools
${toolList}

## Tool Schemas
${toolSchemas}

## How to Use Tools
To call a tool, output the tool name followed by JSON arguments:

EXAMPLE:
To list tracked wallets:
avax_wallet {"action": "list"}

To track a new wallet:
avax_wallet {"action": "track", "address": "0x123...", "tag": "whale1"}

To profile a wallet:
avax_profile {"action": "profile", "address": "0x456..."}

## Instructions
1. Think briefly about what you need to do
2. If you need to use a tool, output ONLY the tool call (tool name + JSON)
3. After receiving [Tool Result], reason about what to do next
4. When done, provide your final answer without any tool call

## Rules
- Output ONE tool call at a time, nothing else on that line
- Use valid JSON for arguments
- Be concise - don't explain what you're about to do, just do it
- Never fabricate results - only use actual [Tool Result] observations
- Iteration limit: ${task.context.maxIterations} steps`;
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
