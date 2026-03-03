import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  ModelProvider,
  ToolDefinition,
} from '../common/interfaces/agent.types';

export interface CompletionRequest {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface CompletionResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  tokenUsage: { input: number; output: number };
  model: string;
  stopReason: string;
}

@Injectable()
export class ModelClientService {
  private readonly logger = new Logger(ModelClientService.name);
  private claudeClient?: Anthropic;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get('claude.apiKey');
    if (apiKey) {
      this.claudeClient = new Anthropic({ apiKey });
    }
  }

  /**
   * Send a completion request to the appropriate model provider.
   * 3-tier routing: LOCAL (ROBai-Micro) → TURBO (ROBai-Turbo) → CLAUDE
   */
  async complete(
    provider: ModelProvider,
    request: CompletionRequest,
  ): Promise<CompletionResponse> {
    const start = Date.now();

    try {
      let response: CompletionResponse;

      switch (provider) {
        case ModelProvider.CLAUDE:
          response = await this.callClaude(request);
          break;
        case ModelProvider.TURBO:
          response = await this.callOpenWebUI(request, 'turboModel');
          break;
        case ModelProvider.LOCAL:
        default:
          response = await this.callOpenWebUI(request, 'localModel');
          break;
      }

      this.logger.debug(
        `${provider} completion: ${Date.now() - start}ms, ` +
        `tokens: ${response.tokenUsage.input}+${response.tokenUsage.output}`,
      );

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`${provider} completion failed: ${message}`);
      throw error;
    }
  }

  // ── Claude API ──────────────────────────────────────────────

  private async callClaude(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.claudeClient) {
      throw new Error('Claude API client not initialized -check CLAUDE_API_KEY');
    }

    const tools = request.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const modelName = this.configService.get<string>('claude.model') ?? 'claude-sonnet-4-20250514';
    const maxTokens = request.maxTokens ?? this.configService.get<number>('claude.maxTokens') ?? 4096;

    const response = await this.claudeClient.messages.create({
      model: modelName,
      max_tokens: maxTokens,
      system: request.systemPrompt,
      messages: request.messages,
      ...(tools?.length ? { tools } : {}),
      temperature: request.temperature ?? 0.4,
      ...(request.stopSequences?.length
        ? { stop_sequences: request.stopSequences }
        : {}),
    });

    // Parse response content blocks
    let textContent = '';
    const toolCalls: CompletionResponse['toolCalls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      model: response.model,
      stopReason: response.stop_reason ?? 'stop',
    };
  }

  // ── OpenWebUI (OpenAI-compatible API) ───────────────────────
  // Handles both ROBai-Micro (localModel) and ROBai-Turbo (turboModel)

  private async callOpenWebUI(
    request: CompletionRequest,
    configKey: 'localModel' | 'turboModel',
  ): Promise<CompletionResponse> {
    const baseUrl = this.configService.get(`${configKey}.baseUrl`);
    const model = this.configService.get(`${configKey}.model`);
    const apiKey = this.configService.get('openwebui.apiKey');

    // OpenAI-compatible /chat/completions format
    const messages = [
      { role: 'system' as const, content: request.systemPrompt },
      ...request.messages,
    ];

    // Convert tools to OpenAI format
    const tools = request.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add Bearer auth if API key is configured
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? this.configService.get(`${configKey}.maxTokens`),
        stream: false,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        ...(request.stopSequences?.length
          ? { stop: request.stopSequences }
          : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Check for Cloudflare/proxy errors (HTML responses)
      if (errorText.includes('cloudflare') || errorText.includes('<!DOCTYPE') || errorText.includes('<html')) {
        if (response.status === 504 || errorText.toLowerCase().includes('gateway time-out')) {
          throw new Error(`Model timeout: ${model} didn't respond in time. The model may be loading or overloaded.`);
        }
        throw new Error(`Proxy error (${response.status}): The model server may be down or overloaded.`);
      }
      throw new Error(`OpenWebUI ${configKey} error: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    // Verify we got JSON back, not an HTML error page
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      if (text.includes('<html') || text.includes('cloudflare')) {
        throw new Error(`Proxy returned HTML instead of JSON - model server may be down`);
      }
      throw new Error(`Unexpected response type: expected JSON, got ${contentType}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    // Parse tool calls from OpenAI format (native function calling)
    const toolCalls: CompletionResponse['toolCalls'] = [];
    if (message?.tool_calls?.length) {
      for (const tc of message.tool_calls) {
        try {
          toolCalls.push({
            id: tc.id ?? `call_${Date.now()}`,
            name: tc.function?.name ?? '',
            arguments: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments ?? {},
          });
        } catch (e) {
          this.logger.warn(`Failed to parse tool call arguments: ${e}`);
        }
      }
    }

    // Fallback: parse tool calls from text content if model doesn't support native function calling
    // Look for patterns like: <tool>tool_name</tool> <args>{"key": "value"}</args>
    // Or: TOOL: tool_name ARGS: {"key": "value"}
    const content = message?.content ?? '';
    if (toolCalls.length === 0 && content && request.tools?.length) {
      const parsed = this.parseToolCallFromText(content, request.tools);
      if (parsed) {
        toolCalls.push(parsed);
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? model,
      stopReason: choice?.finish_reason ?? 'stop',
    };
  }

  /**
   * Parse tool calls from text output when native function calling isn't supported.
   * Looks for JSON blocks that match tool schemas.
   */
  private parseToolCallFromText(
    content: string,
    tools: ToolDefinition[],
  ): { id: string; name: string; arguments: Record<string, unknown> } | null {
    const toolNames = tools.map(t => t.name);

    // Pattern 1: Look for tool name followed by JSON
    // e.g., "avax_wallet {"action": "list"}" or "avax_wallet: {"action": "list"}"
    for (const toolName of toolNames) {
      const patterns = [
        new RegExp(`${toolName}[:\\s]*({[\\s\\S]*?})`, 'i'),
        new RegExp(`<tool>${toolName}</tool>[\\s\\S]*?<args>({[\\s\\S]*?})</args>`, 'i'),
        new RegExp(`TOOL:\\s*${toolName}[\\s\\S]*?ARGS:\\s*({[\\s\\S]*?})(?:\\n|$)`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match?.[1]) {
          try {
            const args = JSON.parse(match[1]);
            this.logger.debug(`Parsed tool call from text: ${toolName}`);
            return {
              id: `text_${Date.now()}`,
              name: toolName,
              arguments: args,
            };
          } catch {
            // JSON parse failed, try next pattern
          }
        }
      }
    }

    // Pattern 2: Look for any JSON object with an "action" field that matches tool input schema
    const jsonMatch = content.match(/\{[\s\S]*?"action"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const args = JSON.parse(jsonMatch[0]);
        // Find a tool that this could apply to based on the action
        for (const tool of tools) {
          const schema = tool.inputSchema as { properties?: { action?: { enum?: string[] } } };
          const validActions = schema?.properties?.action?.enum;
          if (validActions?.includes(args.action)) {
            this.logger.debug(`Inferred tool ${tool.name} from action: ${args.action}`);
            return {
              id: `inferred_${Date.now()}`,
              name: tool.name,
              arguments: args,
            };
          }
        }
      } catch {
        // JSON parse failed
      }
    }

    return null;
  }
}
