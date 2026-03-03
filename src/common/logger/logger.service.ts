import { Injectable, LoggerService as NestLoggerService, Scope } from '@nestjs/common';
import * as winston from 'winston';
import * as path from 'path';

/**
 * Custom Logger Service
 *
 * Provides file-based logging with:
 * - Daily rotation
 * - Console output
 * - JSON structured logs
 * - Redaction of sensitive data (API keys, secrets)
 */
@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private logger: winston.Logger;
  private context: string = 'App';

  // Patterns to redact from logs
  private readonly REDACT_PATTERNS = [
    /sk-[a-zA-Z0-9-_]+/g,          // Anthropic API keys
    /Bearer\s+[a-zA-Z0-9-_.]+/gi,  // Bearer tokens
    /api[_-]?key[=:]\s*["']?[a-zA-Z0-9-_]+["']?/gi,
    /password[=:]\s*["']?[^"'\s]+["']?/gi,
    /secret[=:]\s*["']?[^"'\s]+["']?/gi,
  ];

  constructor() {
    const logsDir = path.join(process.cwd(), 'logs');

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'debug',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      defaultMeta: { service: 'willagent' },
      transports: [
        // Console transport (colorized)
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
              const ctx = context || this.context;
              const metaStr = Object.keys(meta).length > 1
                ? ` ${JSON.stringify(meta, null, 0)}`
                : '';
              return `${timestamp} [${ctx}] ${level}: ${message}${metaStr}`;
            }),
          ),
        }),

        // File transport - all logs
        new winston.transports.File({
          filename: path.join(logsDir, 'willagent.log'),
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          tailable: true,
        }),

        // File transport - errors only
        new winston.transports.File({
          filename: path.join(logsDir, 'error.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024,
          maxFiles: 3,
        }),

        // File transport - model I/O (for debugging LLM)
        new winston.transports.File({
          filename: path.join(logsDir, 'model-io.log'),
          level: 'debug',
          maxsize: 50 * 1024 * 1024, // 50MB - model outputs can be large
          maxFiles: 3,
        }),
      ],
    });
  }

  setContext(context: string) {
    this.context = context;
  }

  /**
   * Redact sensitive data from log messages
   */
  private redact(message: string): string {
    let redacted = message;
    for (const pattern of this.REDACT_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  log(message: string, ...optionalParams: any[]) {
    const context = optionalParams[0] || this.context;
    this.logger.info(this.redact(message), { context });
  }

  error(message: string, trace?: string, ...optionalParams: any[]) {
    const context = optionalParams[0] || this.context;
    this.logger.error(this.redact(message), { context, trace });
  }

  warn(message: string, ...optionalParams: any[]) {
    const context = optionalParams[0] || this.context;
    this.logger.warn(this.redact(message), { context });
  }

  debug(message: string, ...optionalParams: any[]) {
    const context = optionalParams[0] || this.context;
    this.logger.debug(this.redact(message), { context });
  }

  verbose(message: string, ...optionalParams: any[]) {
    const context = optionalParams[0] || this.context;
    this.logger.verbose(this.redact(message), { context });
  }

  /**
   * Log model input/output for debugging
   */
  logModelIO(
    direction: 'input' | 'output',
    provider: string,
    data: {
      taskId?: string;
      systemPrompt?: string;
      messages?: any[];
      tools?: any[];
      response?: string;
      toolCalls?: any[];
      tokenUsage?: { input: number; output: number };
      latencyMs?: number;
    },
  ) {
    const logData = {
      direction,
      provider,
      taskId: data.taskId,
      timestamp: new Date().toISOString(),
      ...(direction === 'input'
        ? {
            systemPromptLength: data.systemPrompt?.length,
            messageCount: data.messages?.length,
            toolCount: data.tools?.length,
            // Don't log full content to avoid huge logs, just snippets
            systemPromptPreview: this.redact(data.systemPrompt?.slice(0, 200) + '...'),
            lastMessage: this.redact(data.messages?.[data.messages.length - 1]?.content?.slice(0, 500) || ''),
          }
        : {
            responseLength: data.response?.length,
            responsePreview: this.redact(data.response?.slice(0, 500) || ''),
            toolCalls: data.toolCalls?.map(tc => ({ name: tc.name, argsPreview: JSON.stringify(tc.arguments).slice(0, 200) })),
            tokenUsage: data.tokenUsage,
            latencyMs: data.latencyMs,
          }),
    };

    this.logger.debug('Model I/O', { context: 'ModelIO', ...logData });
  }

  /**
   * Log tool execution
   */
  logToolExecution(
    toolName: string,
    args: Record<string, unknown>,
    result: { success: boolean; output?: string; error?: string; executionTimeMs: number },
    taskId?: string,
  ) {
    this.logger.info(`Tool executed: ${toolName}`, {
      context: 'ToolRegistry',
      taskId,
      toolName,
      argsPreview: this.redact(JSON.stringify(args).slice(0, 300)),
      success: result.success,
      outputPreview: this.redact((result.output || result.error || '').slice(0, 500)),
      executionTimeMs: result.executionTimeMs,
    });
  }
}
