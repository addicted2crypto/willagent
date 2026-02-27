import { Injectable, OnModuleInit } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolExecutor, ToolRegistryService } from './tool-registry.service';
import { ToolDefinition, ToolResult } from '../common/interfaces/agent.types';

const execAsync = promisify(exec);

// ── Shell Command Tool ───────────────────────────────────────
// Executes shell commands in a sandboxed context.
// In production, this should run inside a Docker container.

@Injectable()
export class ShellTool implements ToolExecutor, OnModuleInit {
  readonly definition: ToolDefinition = {
    name: 'shell_exec',
    description:
      'Execute a shell command. Use for file operations, system info, ' +
      'running scripts, or any CLI task. Commands run in an isolated sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        workingDir: {
          type: 'string',
          description: 'Working directory (default: /tmp/agent-workspace)',
        },
      },
      required: ['command'],
    },
    sandboxed: true,
    timeout: 30000,
    tags: ['system', 'shell', 'files'],
  };

  /** Blocked commands for safety */
  private readonly blocklist = [
    'rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb',
    'chmod 777 /', 'curl | sh', 'wget | sh',
  ];

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const workingDir = (args.workingDir as string) ?? '/tmp/agent-workspace';

    // Safety check
    const blocked = this.blocklist.find(b => command.toLowerCase().includes(b));
    if (blocked) {
      return {
        success: false,
        output: '',
        error: `Blocked command pattern detected: "${blocked}"`,
        executionTimeMs: 0,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        timeout: 25000,
        maxBuffer: 1024 * 1024, // 1MB
        env: {
          ...process.env,
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/tmp/agent-workspace',
        },
      });

      return {
        success: true,
        output: stdout.trim() || stderr.trim() || '(no output)',
        executionTimeMs: 0,
      };
    } catch (error) {
      return {
        success: false,
        output: error.stdout?.trim() ?? '',
        error: error.stderr?.trim() ?? error.message,
        executionTimeMs: 0,
      };
    }
  }
}

// ── Web Fetch Tool ───────────────────────────────────────────
// Fetches content from a URL and returns the text.

@Injectable()
export class WebFetchTool implements ToolExecutor, OnModuleInit {
  readonly definition: ToolDefinition = {
    name: 'web_fetch',
    description:
      'Fetch the text content of a web page given a URL. ' +
      'Returns the page body as plain text (HTML stripped). ' +
      'Use for scraping data, checking API endpoints, or reading docs.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        maxLength: {
          type: 'number',
          description: 'Max characters to return (default: 5000)',
        },
      },
      required: ['url'],
    },
    sandboxed: false,
    timeout: 15000,
    tags: ['web', 'fetch', 'scrape'],
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;
    const maxLength = (args.maxLength as number) ?? 5000;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'WillAgent/0.1' },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status}: ${response.statusText}`,
          executionTimeMs: 0,
        };
      }

      const html = await response.text();
      // Basic HTML → text stripping
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);

      return {
        success: true,
        output: text,
        metadata: {
          url,
          contentLength: text.length,
          truncated: html.length > maxLength,
        },
        executionTimeMs: 0,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error.message,
        executionTimeMs: 0,
      };
    }
  }
}

// ── JSON Transform Tool ──────────────────────────────────────
// Lightweight data transformation using jq-style operations.

@Injectable()
export class JsonTransformTool implements ToolExecutor, OnModuleInit {
  readonly definition: ToolDefinition = {
    name: 'json_transform',
    description:
      'Transform JSON data by extracting fields, filtering arrays, ' +
      'or reshaping objects. Provide the input JSON and a transform spec.',
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          description: 'The JSON data to transform',
        },
        extract: {
          type: 'string',
          description: 'Dot-notation path to extract (e.g., "users.0.name")',
        },
        filterKey: {
          type: 'string',
          description: 'If data is an array, filter by this key',
        },
        filterValue: {
          type: 'string',
          description: 'Value to match for filtering',
        },
      },
      required: ['data'],
    },
    sandboxed: false,
    timeout: 5000,
    tags: ['data', 'json', 'transform'],
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      let result: unknown = args.data;

      // Extract by dot path
      if (args.extract) {
        const path = (args.extract as string).split('.');
        for (const key of path) {
          if (result == null) break;
          result = (result as Record<string, unknown>)[key];
        }
      }

      // Filter array
      if (args.filterKey && Array.isArray(result)) {
        result = (result as Record<string, unknown>[]).filter(
          item => String(item[args.filterKey as string]) === String(args.filterValue),
        );
      }

      return {
        success: true,
        output: JSON.stringify(result, null, 2),
        executionTimeMs: 0,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error.message,
        executionTimeMs: 0,
      };
    }
  }
}
