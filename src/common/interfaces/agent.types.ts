// ============================================================
// WillAgent - Core Type Definitions
// ============================================================

/** Complexity tiers for model routing */
export enum TaskComplexity {
  LOW = 'low',       // Local model handles it (triage, simple transforms)
  MEDIUM = 'medium', // Local model with tool access
  HIGH = 'high',     // Claude API for multi-step reasoning
  CRITICAL = 'critical', // Claude API with full tool chain + validation
}

/** Supported model providers */
export enum ModelProvider {
  LOCAL = 'local',     // ROBai-Micro (Qwen3 30B) via OpenWebUI
  TURBO = 'turbo',     // ROBai-Turbo (GPT 120B) via OpenWebUI
  CLAUDE = 'claude',   // Anthropic Claude API
}

/** ReACT loop step types */
export enum StepType {
  THOUGHT = 'thought',
  ACTION = 'action',
  OBSERVATION = 'observation',
  FINAL = 'final_answer',
}

/** Agent task status */
export enum TaskStatus {
  QUEUED = 'queued',
  PLANNING = 'planning',
  EXECUTING = 'executing',
  AWAITING_TOOL = 'awaiting_tool',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** A single step in the ReACT execution loop */
export interface AgentStep {
  id: string;
  type: StepType;
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  model: ModelProvider;
  tokenUsage: { input: number; output: number };
  latencyMs: number;
  timestamp: Date;
}

/** Tool invocation request */
export interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  timeout?: number;
}

/** Tool execution result */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  executionTimeMs: number;
  metadata?: Record<string, unknown>;
}

/** Full agent task with execution history */
export interface AgentTask {
  id: string;
  input: string;
  status: TaskStatus;
  complexity: TaskComplexity;
  steps: AgentStep[];
  finalAnswer?: string;
  context: TaskContext;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/** Contextual info passed along with a task */
export interface TaskContext {
  conversationId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  /** Previous task IDs this task depends on */
  dependencies?: string[];
  /** Max ReACT loop iterations before forced stop */
  maxIterations: number;
  /** Which tools are allowed for this task */
  allowedTools: string[];
}

/** Tool definition for the registry */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether this tool runs in a sandboxed container */
  sandboxed: boolean;
  /** Max execution time in ms */
  timeout: number;
  /** Tags for routing logic */
  tags: string[];
}

/** Model routing decision */
export interface RoutingDecision {
  provider: ModelProvider;
  model: string;
  reasoning: string;
  estimatedCost: number;
  complexity: TaskComplexity;
}

/** Configuration for model providers */
export interface ModelConfig {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
}

/** Audit log entry for every agent action */
export interface AuditLogEntry {
  id: string;
  taskId: string;
  action: string;
  details: Record<string, unknown>;
  timestamp: Date;
  provider?: ModelProvider;
  toolName?: string;
}
