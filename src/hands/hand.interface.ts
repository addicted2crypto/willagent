import type { ModelProvider } from '../common/interfaces/agent.types';

/**
 * Configuration for a Hand - an autonomous capability package
 * that can run on a schedule and use specific tools.
 */
export interface HandConfig {
  /** Unique identifier, e.g. "chain-watcher" */
  id: string;

  /** Human-readable name */
  name: string;

  /** What this Hand does */
  description: string;

  /** Semantic version */
  version: string;

  /** Cron expression for scheduling, null = on-demand only */
  schedule: string | null;

  /** Execute immediately when activated */
  runOnStart: boolean;

  /** Primary model tier to use */
  modelTier: 'LOCAL' | 'TURBO' | 'CLAUDE';

  /** Maximum tokens per run (hard ceiling) */
  maxTokensBudget: number;

  /** Fallback tier if primary fails or confidence is low */
  fallbackTier?: 'TURBO' | 'CLAUDE';

  /** Tool whitelist - only these tools are available to this Hand */
  allowedTools: string[];

  /** Path to SKILL.md file for domain knowledge injection */
  skillPath: string;

  /** Dashboard metrics to track */
  metrics: HandMetric[];
}

/**
 * Metric definition for Hand dashboard
 */
export interface HandMetric {
  /** Unique key, e.g. "events_detected" */
  key: string;

  /** Display label */
  label: string;

  /** Type: counter (cumulative), gauge (current value), list (recent items) */
  type: 'counter' | 'gauge' | 'list';
}

/**
 * Runtime state of a Hand
 */
export enum HandState {
  /** Not activated, won't run */
  INACTIVE = 'inactive',

  /** Activated and ready to run on schedule */
  ACTIVE = 'active',

  /** Currently executing */
  RUNNING = 'running',

  /** Activated but temporarily paused */
  PAUSED = 'paused',

  /** Error during last run */
  ERROR = 'error',
}

/**
 * Runtime information about a Hand
 */
export interface HandRuntime {
  /** Hand configuration */
  config: HandConfig;

  /** Current state */
  state: HandState;

  /** When the Hand was activated */
  activatedAt: Date | null;

  /** Last execution time */
  lastRunAt: Date | null;

  /** Next scheduled execution */
  nextRunAt: Date | null;

  /** Last run duration in ms */
  lastRunDurationMs: number | null;

  /** Error from last run, if any */
  lastError: string | null;

  /** Current metric values */
  metricValues: Record<string, number | string[]>;

  /** Loaded skill content */
  skillContent: string | null;
}

/**
 * Result of a Hand execution
 */
export interface HandRunResult {
  handId: string;
  success: boolean;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  modelTier: 'LOCAL' | 'TURBO' | 'CLAUDE';
  tokensUsed: number;
  output: string;
  error?: string;
  metrics?: Record<string, number | string[]>;
}

/**
 * Base interface for Hand implementations
 */
export interface IHand {
  /** Get the Hand configuration */
  getConfig(): HandConfig;

  /** Execute the Hand's main logic */
  execute(context: HandExecutionContext): Promise<HandRunResult>;
}

/**
 * Context provided to Hand execution
 */
export interface HandExecutionContext {
  /** Unique run ID */
  runId: string;

  /** Loaded skill content to inject into prompts */
  skillContent: string;

  /** Emit progress updates */
  emitProgress: (message: string, progress?: number) => void;

  /** Log a message */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

  /** Update a metric */
  updateMetric: (key: string, value: number | string | ((prev: number) => number)) => void;
}
