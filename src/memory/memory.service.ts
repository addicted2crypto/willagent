import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  AgentTask,
  AuditLogEntry,
} from '../common/interfaces/agent.types';

/**
 * MemoryService
 *
 * Persistent state layer using Redis. Stores:
 * - Active task state (for resuming interrupted tasks)
 * - Conversation history (for multi-turn context)
 * - Audit logs (for security/compliance)
 * - Tool result cache (avoid redundant calls)
 */
@Injectable()
export class MemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(MemoryService.name);
  private redis: Redis;
  private connected = false;

  /** Key prefixes for organized storage */
  private readonly PREFIX = {
    task: 'agent:task:',
    conversation: 'agent:conv:',
    audit: 'agent:audit:',
    cache: 'agent:cache:',
  };

  /** TTLs in seconds */
  private readonly TTL = {
    task: 86400,        // 24 hours
    conversation: 604800, // 7 days
    audit: 2592000,     // 30 days
    cache: 3600,        // 1 hour
  };

  constructor(private readonly configService: ConfigService) {
    this.initRedis();
  }

  private initRedis(): void {
    try {
      this.redis = new Redis({
        host: this.configService.get('redis.host'),
        port: this.configService.get('redis.port'),
        password: this.configService.get('redis.password') || undefined,
        db: this.configService.get('redis.db'),
        retryStrategy: (times) => Math.min(times * 50, 2000),
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        this.connected = true;
        this.logger.log('Redis connected');
      });

      this.redis.on('error', (err) => {
        if (this.connected) {
          this.logger.warn(`Redis error: ${err.message} -falling back to in-memory`);
        }
        this.connected = false;
      });

      this.redis.connect().catch(() => {
        this.logger.warn('Redis unavailable -using in-memory fallback');
      });
    } catch {
      this.logger.warn('Redis init failed -using in-memory fallback');
    }
  }

  /** In-memory fallback when Redis is unavailable */
  private fallbackStore = new Map<string, string>();

  // ── Task State ──────────────────────────────────────────────

  async saveTask(task: AgentTask): Promise<void> {
    const key = `${this.PREFIX.task}${task.id}`;
    const data = JSON.stringify(task);

    if (this.connected) {
      await this.redis.setex(key, this.TTL.task, data);
    } else {
      this.fallbackStore.set(key, data);
    }
  }

  async getTask(taskId: string): Promise<AgentTask | null> {
    const key = `${this.PREFIX.task}${taskId}`;

    const data = this.connected
      ? await this.redis.get(key)
      : this.fallbackStore.get(key);

    return data ? JSON.parse(data) : null;
  }

  // ── Conversation History ────────────────────────────────────

  async appendMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<void> {
    const key = `${this.PREFIX.conversation}${conversationId}`;
    const message = JSON.stringify({ role, content, timestamp: new Date() });

    if (this.connected) {
      await this.redis.rpush(key, message);
      await this.redis.expire(key, this.TTL.conversation);
    } else {
      const existing = this.fallbackStore.get(key) ?? '[]';
      const messages = JSON.parse(existing);
      messages.push(message);
      this.fallbackStore.set(key, JSON.stringify(messages));
    }
  }

  async getConversation(
    conversationId: string,
    limit = 50,
  ): Promise<Array<{ role: string; content: string }>> {
    const key = `${this.PREFIX.conversation}${conversationId}`;

    if (this.connected) {
      const messages = await this.redis.lrange(key, -limit, -1);
      return messages.map(m => JSON.parse(m));
    }

    const data = this.fallbackStore.get(key);
    if (!data) return [];
    const messages = JSON.parse(data).map((m: string) =>
      typeof m === 'string' ? JSON.parse(m) : m,
    );
    return messages.slice(-limit);
  }

  // ── Audit Log ───────────────────────────────────────────────

  async logAudit(entry: AuditLogEntry): Promise<void> {
    const key = `${this.PREFIX.audit}${entry.taskId}`;
    const data = JSON.stringify(entry);

    if (this.connected) {
      await this.redis.rpush(key, data);
      await this.redis.expire(key, this.TTL.audit);
    }
    // Always log to console for debugging
    this.logger.verbose(`AUDIT [${entry.taskId}] ${entry.action}`);
  }

  // ── Tool Result Cache ───────────────────────────────────────

  async getCached(cacheKey: string): Promise<string | null> {
    const key = `${this.PREFIX.cache}${cacheKey}`;
    return this.connected
      ? await this.redis.get(key)
      : this.fallbackStore.get(key) ?? null;
  }

  async setCache(cacheKey: string, value: string, ttl?: number): Promise<void> {
    const key = `${this.PREFIX.cache}${cacheKey}`;
    if (this.connected) {
      await this.redis.setex(key, ttl ?? this.TTL.cache, value);
    } else {
      this.fallbackStore.set(key, value);
    }
  }

  async deleteCache(cacheKey: string): Promise<void> {
    const key = `${this.PREFIX.cache}${cacheKey}`;
    if (this.connected) {
      await this.redis.del(key);
    } else {
      this.fallbackStore.delete(key);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────

  async onModuleDestroy(): Promise<void> {
    if (this.connected) {
      await this.redis.quit();
    }
  }
}
