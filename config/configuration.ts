import { registerAs } from '@nestjs/config';

export const agentConfig = registerAs('agent', () => ({
  maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS ?? '15', 10),
  defaultTimeout: parseInt(process.env.AGENT_DEFAULT_TIMEOUT ?? '30000', 10),
  enableAuditLog: process.env.AGENT_ENABLE_AUDIT_LOG === 'true',
}));

export const claudeConfig = registerAs('claude', () => ({
  apiKey: process.env.CLAUDE_API_KEY,
  model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',
  maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS ?? '4096', 10),
  baseUrl: process.env.CLAUDE_BASE_URL ?? 'https://api.anthropic.com',
}));

// OpenWebUI unified API gateway
export const openwebuiConfig = registerAs('openwebui', () => ({
  baseUrl: process.env.OPENWEBUI_BASE_URL ?? 'http://localhost:3000/api/v1',
  apiKey: process.env.OPENWEBUI_API_KEY,
}));

// ROBai-Micro (Qwen3 30B) - LOW/MEDIUM complexity
export const localModelConfig = registerAs('localModel', () => ({
  baseUrl: process.env.OPENWEBUI_BASE_URL ?? 'http://localhost:3000/api/v1',
  model: process.env.LOCAL_MODEL_NAME ?? 'robai-micro',
  maxTokens: parseInt(process.env.LOCAL_MODEL_MAX_TOKENS ?? '4096', 10),
}));

// ROBai-Turbo (GPT 120B) - HIGH complexity
export const turboModelConfig = registerAs('turboModel', () => ({
  baseUrl: process.env.OPENWEBUI_BASE_URL ?? 'http://localhost:3000/api/v1',
  model: process.env.TURBO_MODEL_NAME ?? 'robai-turbo',
  maxTokens: parseInt(process.env.TURBO_MODEL_MAX_TOKENS ?? '8192', 10),
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB ?? '0', 10),
}));

export const sandboxConfig = registerAs('sandbox', () => ({
  image: process.env.SANDBOX_IMAGE || 'willagent-sandbox:latest',
  memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || '256m',
  cpuLimit: process.env.SANDBOX_CPU_LIMIT || '0.5',
  network: process.env.SANDBOX_NETWORK || 'none',
}));

// AVAX C-Chain configuration
export const avaxConfig = registerAs('avax', () => ({
  rpcUrl: process.env.AVAX_RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc',
  alchemyUrl: process.env.ALCHEMY_AVAX_URL,
  ankrApiKey: process.env.ANKR_API_KEY,  // Premium RPC endpoint
  snowtraceKey: process.env.SNOWTRACE_API_KEY,
  pollIntervalMs: parseInt(process.env.AVAX_POLL_INTERVAL_MS ?? '30000', 10),
}));
