import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import {
  HandConfig,
  HandState,
  HandRuntime,
  HandRunResult,
  IHand,
  HandExecutionContext,
} from './hand.interface';
import { SkillLoaderService } from './skill-loader.service';

/**
 * HandManager is the central service for managing Hand lifecycle:
 * - Registration and discovery
 * - Activation/pause/resume
 * - Execution with tool filtering
 * - Metric tracking
 * - State management
 */
@Injectable()
export class HandManagerService implements OnModuleInit {
  private readonly logger = new Logger(HandManagerService.name);
  private readonly hands = new Map<string, IHand>();
  private readonly runtimes = new Map<string, HandRuntime>();
  private readonly runHistory = new Map<string, HandRunResult[]>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly skillLoader: SkillLoaderService,
  ) {}

  async onModuleInit() {
    this.logger.log('HandManager initialized');
    // Hands will register themselves via registerHand()
  }

  /**
   * Register a Hand with the manager.
   * Called by each Hand module during initialization.
   */
  registerHand(hand: IHand): void {
    const config = hand.getConfig();

    if (this.hands.has(config.id)) {
      this.logger.warn(`Hand ${config.id} already registered, skipping`);
      return;
    }

    this.hands.set(config.id, hand);
    this.runtimes.set(config.id, {
      config,
      state: HandState.INACTIVE,
      activatedAt: null,
      lastRunAt: null,
      nextRunAt: null,
      lastRunDurationMs: null,
      lastError: null,
      metricValues: this.initializeMetrics(config.metrics),
      skillContent: null,
    });
    this.runHistory.set(config.id, []);

    this.logger.log(`Registered Hand: ${config.id} (${config.name})`);
    this.eventEmitter.emit('hand.registered', { handId: config.id, config });
  }

  /**
   * Activate a Hand - load its skill and start scheduling.
   */
  async activateHand(handId: string): Promise<boolean> {
    const runtime = this.runtimes.get(handId);
    if (!runtime) {
      this.logger.error(`Hand ${handId} not found`);
      return false;
    }

    if (runtime.state === HandState.ACTIVE || runtime.state === HandState.RUNNING) {
      this.logger.warn(`Hand ${handId} is already active`);
      return true;
    }

    // Load skill content
    const skillContent = await this.skillLoader.loadSkill(runtime.config.skillPath);
    runtime.skillContent = skillContent;
    runtime.state = HandState.ACTIVE;
    runtime.activatedAt = new Date();

    this.logger.log(`Activated Hand: ${handId}`);
    this.eventEmitter.emit('hand.activated', { handId, runtime });

    // Run on start if configured
    if (runtime.config.runOnStart) {
      this.logger.log(`Running ${handId} on start`);
      // Don't await - run async
      this.runHand(handId).catch((err) => {
        this.logger.error(`Error running ${handId} on start:`, err);
      });
    }

    return true;
  }

  /**
   * Pause a Hand - stop scheduling but keep state.
   */
  pauseHand(handId: string): boolean {
    const runtime = this.runtimes.get(handId);
    if (!runtime) {
      this.logger.error(`Hand ${handId} not found`);
      return false;
    }

    if (runtime.state === HandState.INACTIVE || runtime.state === HandState.PAUSED) {
      return true;
    }

    runtime.state = HandState.PAUSED;
    this.logger.log(`Paused Hand: ${handId}`);
    this.eventEmitter.emit('hand.paused', { handId, runtime });

    return true;
  }

  /**
   * Resume a paused Hand.
   */
  resumeHand(handId: string): boolean {
    const runtime = this.runtimes.get(handId);
    if (!runtime) {
      this.logger.error(`Hand ${handId} not found`);
      return false;
    }

    if (runtime.state !== HandState.PAUSED) {
      return false;
    }

    runtime.state = HandState.ACTIVE;
    this.logger.log(`Resumed Hand: ${handId}`);
    this.eventEmitter.emit('hand.resumed', { handId, runtime });

    return true;
  }

  /**
   * Deactivate a Hand completely.
   */
  deactivateHand(handId: string): boolean {
    const runtime = this.runtimes.get(handId);
    if (!runtime) {
      this.logger.error(`Hand ${handId} not found`);
      return false;
    }

    runtime.state = HandState.INACTIVE;
    runtime.skillContent = null;
    this.logger.log(`Deactivated Hand: ${handId}`);
    this.eventEmitter.emit('hand.deactivated', { handId, runtime });

    return true;
  }

  /**
   * Execute a Hand manually or from scheduler.
   */
  async runHand(handId: string): Promise<HandRunResult | null> {
    const hand = this.hands.get(handId);
    const runtime = this.runtimes.get(handId);

    if (!hand || !runtime) {
      this.logger.error(`Hand ${handId} not found`);
      return null;
    }

    if (runtime.state === HandState.INACTIVE) {
      this.logger.warn(`Hand ${handId} is inactive, cannot run`);
      return null;
    }

    if (runtime.state === HandState.RUNNING) {
      this.logger.warn(`Hand ${handId} is already running`);
      return null;
    }

    // Mark as running
    const previousState = runtime.state;
    runtime.state = HandState.RUNNING;
    runtime.lastRunAt = new Date();

    const runId = uuidv4();
    const startedAt = new Date();

    this.logger.log(`Running Hand: ${handId} (runId: ${runId})`);
    this.eventEmitter.emit('hand.run.started', { handId, runId, startedAt });

    // Build execution context
    const context: HandExecutionContext = {
      runId,
      skillContent: runtime.skillContent || '',
      emitProgress: (message: string, progress?: number) => {
        this.eventEmitter.emit('hand.run.progress', { handId, runId, message, progress });
      },
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
        this.logger[level](`[${handId}] ${message}`);
      },
      updateMetric: (key: string, value: number | string | ((prev: number) => number)) => {
        this.updateMetric(handId, key, value);
      },
    };

    try {
      const result = await hand.execute(context);

      // Update runtime
      runtime.state = previousState === HandState.PAUSED ? HandState.PAUSED : HandState.ACTIVE;
      runtime.lastRunDurationMs = result.durationMs;
      runtime.lastError = result.error || null;

      // Apply metrics from result
      if (result.metrics) {
        for (const [key, value] of Object.entries(result.metrics)) {
          runtime.metricValues[key] = value;
        }
      }

      // Store in history (keep last 100 runs)
      const history = this.runHistory.get(handId) || [];
      history.push(result);
      if (history.length > 100) {
        history.shift();
      }

      this.logger.log(`Hand ${handId} completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      this.eventEmitter.emit('hand.run.completed', { handId, runId, result });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      runtime.state = HandState.ERROR;
      runtime.lastError = errorMessage;

      this.logger.error(`Hand ${handId} error: ${errorMessage}`);
      this.eventEmitter.emit('hand.run.error', { handId, runId, error: errorMessage });

      return {
        handId,
        success: false,
        startedAt,
        completedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        modelTier: runtime.config.modelTier,
        tokensUsed: 0,
        output: '',
        error: errorMessage,
      };
    }
  }

  /**
   * Get runtime info for a Hand.
   */
  getRuntime(handId: string): HandRuntime | undefined {
    return this.runtimes.get(handId);
  }

  /**
   * Get all registered Hands.
   */
  getAllHands(): HandRuntime[] {
    return Array.from(this.runtimes.values());
  }

  /**
   * Get run history for a Hand.
   */
  getRunHistory(handId: string, limit = 10): HandRunResult[] {
    const history = this.runHistory.get(handId) || [];
    return history.slice(-limit);
  }

  /**
   * Update a metric value for a Hand.
   */
  private updateMetric(
    handId: string,
    key: string,
    value: number | string | ((prev: number) => number),
  ): void {
    const runtime = this.runtimes.get(handId);
    if (!runtime) return;

    const current = runtime.metricValues[key];

    if (typeof value === 'function' && typeof current === 'number') {
      runtime.metricValues[key] = value(current);
    } else if (typeof value === 'string' && Array.isArray(current)) {
      // For list metrics, push to array
      current.push(value);
      // Keep last 50 items
      if (current.length > 50) {
        current.shift();
      }
    } else {
      runtime.metricValues[key] = value as number;
    }
  }

  /**
   * Initialize metric values based on config.
   */
  private initializeMetrics(metrics: HandConfig['metrics']): Record<string, number | string[]> {
    const values: Record<string, number | string[]> = {};
    for (const metric of metrics) {
      values[metric.key] = metric.type === 'list' ? [] : 0;
    }
    return values;
  }

  /**
   * Check if a tool is allowed for a specific Hand.
   */
  isToolAllowed(handId: string, toolName: string): boolean {
    const runtime = this.runtimes.get(handId);
    if (!runtime) return false;
    return runtime.config.allowedTools.includes(toolName);
  }

  /**
   * Get allowed tools for a Hand.
   */
  getAllowedTools(handId: string): string[] {
    const runtime = this.runtimes.get(handId);
    if (!runtime) return [];
    return runtime.config.allowedTools;
  }
}
