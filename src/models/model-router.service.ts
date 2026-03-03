import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TaskComplexity,
  ModelProvider,
  RoutingDecision,
  ModelConfig,
} from '../common/interfaces/agent.types';

/**
 * ModelRouterService
 *
 * Routes tasks to the appropriate model provider based on complexity.
 * 3-tier routing through OpenWebUI:
 *   - LOW/MEDIUM  → ROBai-Micro (Qwen3 30B) - fast, free
 *   - HIGH        → ROBai-Turbo (GPT 120B) - powerful, free
 *   - CRITICAL    → Claude API - best reasoning (when configured)
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);
  private readonly localConfig: ModelConfig;   // ROBai-Micro
  private readonly turboConfig: ModelConfig;   // ROBai-Turbo
  private readonly claudeApiConfig: ModelConfig;

  /** Keywords/patterns that signal high-complexity tasks */
  private readonly complexitySignals = {
    high: [
      'analyze', 'compare', 'strategy', 'architecture', 'debug complex',
      'refactor', 'security audit', 'optimize', 'design pattern',
      'multi-step', 'plan', 'review code',
    ],
    low: [
      'format', 'convert', 'list', 'summarize short', 'translate simple',
      'extract', 'classify', 'label', 'triage',
    ],
  };

  constructor(private readonly configService: ConfigService) {
    // ROBai-Micro (Qwen3 30B) - LOW/MEDIUM complexity
    this.localConfig = {
      provider: ModelProvider.LOCAL,
      baseUrl: this.configService.get<string>('localModel.baseUrl') ?? 'http://localhost:3000/api/v1',
      model: this.configService.get<string>('localModel.model') ?? 'robai-micro',
      maxTokens: this.configService.get<number>('localModel.maxTokens') ?? 4096,
      temperature: 0.3,
    };

    // ROBai-Turbo (GPT 120B) - HIGH complexity
    this.turboConfig = {
      provider: ModelProvider.TURBO,
      baseUrl: this.configService.get<string>('turboModel.baseUrl') ?? 'http://localhost:3000/api/v1',
      model: this.configService.get<string>('turboModel.model') ?? 'robai-turbo',
      maxTokens: this.configService.get<number>('turboModel.maxTokens') ?? 8192,
      temperature: 0.4,
    };

    // Claude API - CRITICAL complexity (optional)
    this.claudeApiConfig = {
      provider: ModelProvider.CLAUDE,
      baseUrl: this.configService.get<string>('claude.baseUrl') ?? 'https://api.anthropic.com',
      model: this.configService.get<string>('claude.model') ?? 'claude-sonnet-4-20250514',
      apiKey: this.configService.get<string>('claude.apiKey'),
      maxTokens: this.configService.get<number>('claude.maxTokens') ?? 4096,
      temperature: 0.4,
    };
  }

  /**
   * Classify task complexity based on input analysis.
   * Analyzes the query text itself, NOT the number of available tools.
   */
  classifyComplexity(input: string, _toolsRequired: string[] = []): TaskComplexity {
    const lower = input.toLowerCase();
    const words = lower.split(/\s+/).length;

    // Short simple queries without complexity signals → LOW
    // e.g., "2+2", "What is the capital of France?"
    if (words <= 10 && !this.containsComplexSignals(lower)) {
      return TaskComplexity.LOW;
    }

    // Check keyword signals
    const highScore = this.complexitySignals.high.filter(s => lower.includes(s)).length;
    const lowScore = this.complexitySignals.low.filter(s => lower.includes(s)).length;

    // Input length is a rough proxy for complexity
    const lengthScore = input.length > 500 ? 2 : input.length > 200 ? 1 : 0;

    const totalScore = highScore - lowScore + lengthScore;

    if (totalScore >= 3) return TaskComplexity.CRITICAL;
    if (totalScore >= 2) return TaskComplexity.HIGH;
    if (totalScore >= 1) return TaskComplexity.MEDIUM;
    return TaskComplexity.LOW;
  }

  /**
   * Check if input contains signals that indicate higher complexity.
   */
  private containsComplexSignals(lower: string): boolean {
    const signals = [
      'analyze', 'compare', 'explain why', 'how does', 'implement',
      'debug', 'refactor', 'optimize', 'architecture', 'security',
      'multi-step', 'workflow', 'strategy',
    ];
    return signals.some(s => lower.includes(s));
  }

  /**
   * Route a task to the best model provider.
   * Returns the full routing decision with reasoning.
   */
  route(
    input: string,
    toolsRequired: string[] = [],
    overrideComplexity?: TaskComplexity,
  ): RoutingDecision {
    const complexity = overrideComplexity ?? this.classifyComplexity(input, toolsRequired);

    const decision = this.makeDecision(complexity, toolsRequired);

    this.logger.log(
      `Routed task → ${decision.provider}/${decision.model} ` +
      `[complexity=${complexity}, tools=${toolsRequired.length}]`,
    );

    return decision;
  }

  private makeDecision(
    complexity: TaskComplexity,
    toolsRequired: string[],
  ): RoutingDecision {
    const claudeAvailable = !!this.claudeApiConfig.apiKey;

    switch (complexity) {
      case TaskComplexity.LOW:
        // ROBai-Micro handles simple tasks
        return {
          provider: ModelProvider.LOCAL,
          model: this.localConfig.model,
          reasoning: 'Simple task -ROBai-Micro (Qwen3 30B) is fast and sufficient',
          estimatedCost: 0,
          complexity,
        };

      case TaskComplexity.MEDIUM:
        // ROBai-Micro handles medium complexity with minimal tools
        if (toolsRequired.length <= 1) {
          return {
            provider: ModelProvider.LOCAL,
            model: this.localConfig.model,
            reasoning: 'Medium complexity -ROBai-Micro can handle with tool access',
            estimatedCost: 0,
            complexity,
          };
        }
        // Multi-tool medium tasks go to Turbo
        return {
          provider: ModelProvider.TURBO,
          model: this.turboConfig.model,
          reasoning: 'Medium complexity with multi-tool -ROBai-Turbo for reliable orchestration',
          estimatedCost: 0,
          complexity,
        };

      case TaskComplexity.HIGH:
        // ROBai-Turbo handles high complexity locally
        return {
          provider: ModelProvider.TURBO,
          model: this.turboConfig.model,
          reasoning: 'High complexity -ROBai-Turbo (GPT 120B) for advanced reasoning',
          estimatedCost: 0,
          complexity,
        };

      case TaskComplexity.CRITICAL:
        // Claude for critical tasks (if available), otherwise Turbo
        if (claudeAvailable) {
          return {
            provider: ModelProvider.CLAUDE,
            model: this.claudeApiConfig.model,
            reasoning: 'Critical task requiring best reasoning -Claude API',
            estimatedCost: this.estimateCost(8000),
            complexity,
          };
        }
        // Fallback to Turbo if Claude not configured
        return {
          provider: ModelProvider.TURBO,
          model: this.turboConfig.model,
          reasoning: 'Critical task -ROBai-Turbo (Claude API not configured)',
          estimatedCost: 0,
          complexity,
        };
    }
  }

  /** Rough cost estimate in USD based on token count */
  private estimateCost(estimatedTokens: number): number {
    // Claude Sonnet pricing: ~$3/M input, ~$15/M output (approximate)
    const inputCost = (estimatedTokens * 0.5 * 3) / 1_000_000;
    const outputCost = (estimatedTokens * 0.5 * 15) / 1_000_000;
    return Math.round((inputCost + outputCost) * 10000) / 10000;
  }

  /** Get the model config for a specific provider */
  getConfig(provider: ModelProvider): ModelConfig {
    switch (provider) {
      case ModelProvider.CLAUDE:
        return this.claudeApiConfig;
      case ModelProvider.TURBO:
        return this.turboConfig;
      case ModelProvider.LOCAL:
      default:
        return this.localConfig;
    }
  }
}
