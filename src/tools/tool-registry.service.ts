import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../common/interfaces/agent.types';

/** Interface that all tool executors must implement */
export interface ToolExecutor {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * ToolRegistryService
 *
 * Central registry for all available tools. Tools register themselves
 * at startup, and the agent orchestrator queries this registry to
 * know what capabilities are available.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, ToolExecutor>();

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /** Register a tool executor */
  register(executor: ToolExecutor): void {
    const { name } = executor.definition;
    if (this.tools.has(name)) {
      this.logger.warn(`Tool "${name}" already registered — overwriting`);
    }
    this.tools.set(name, executor);
    this.logger.log(`Registered tool: ${name} [sandboxed=${executor.definition.sandboxed}]`);
  }

  /** Get all registered tool definitions (for LLM system prompt) */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /** Get definitions filtered by allowed tool names */
  getFilteredDefinitions(allowedTools: string[]): ToolDefinition[] {
    if (allowedTools.includes('*')) return this.getDefinitions();
    return this.getDefinitions().filter(d => allowedTools.includes(d.name));
  }

  /** Check if a tool exists */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Execute a tool call with timeout and error handling.
   * Emits audit events for every execution.
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const executor = this.tools.get(call.toolName);

    if (!executor) {
      return {
        success: false,
        output: '',
        error: `Unknown tool: "${call.toolName}". Available: ${Array.from(this.tools.keys()).join(', ')}`,
        executionTimeMs: 0,
      };
    }

    const timeout = call.timeout ?? executor.definition.timeout;
    const start = Date.now();

    this.eventEmitter.emit('tool.started', {
      toolName: call.toolName,
      arguments: call.arguments,
      timestamp: new Date(),
    });

    try {
      const result = await Promise.race([
        executor.execute(call.arguments),
        this.createTimeout(timeout, call.toolName),
      ]);

      const executionTimeMs = Date.now() - start;

      this.eventEmitter.emit('tool.completed', {
        toolName: call.toolName,
        success: result.success,
        executionTimeMs,
        timestamp: new Date(),
      });

      return { ...result, executionTimeMs };
    } catch (error) {
      const executionTimeMs = Date.now() - start;

      this.eventEmitter.emit('tool.failed', {
        toolName: call.toolName,
        error: error.message,
        executionTimeMs,
        timestamp: new Date(),
      });

      return {
        success: false,
        output: '',
        error: `Tool "${call.toolName}" failed: ${error.message}`,
        executionTimeMs,
      };
    }
  }

  private createTimeout(ms: number, toolName: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${ms}ms`)), ms),
    );
  }
}
