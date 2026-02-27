# 🤖 WillAgent

Self-hosted AI agent orchestrator with multi-model routing, ReACT execution, and pluggable tool system.

> Built as a secure, transparent alternative to hosted agent platforms. Full control over data pipeline, model routing, and tool execution.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    API Gateway                       │
│              POST /api/v1/agent/task                 │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Model Router Service                    │
│   Classifies complexity → routes to best provider    │
│                                                      │
│   LOW/MEDIUM  ──→  Local Model (Ollama/vLLM)        │
│   HIGH/CRIT   ──→  Claude API (Anthropic)           │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│            Agent Orchestrator (ReACT Loop)            │
│                                                      │
│   ┌─────────┐   ┌────────┐   ┌─────────────┐       │
│   │ THOUGHT │──▶│ ACTION │──▶│ OBSERVATION │──┐     │
│   └─────────┘   └────────┘   └─────────────┘  │     │
│        ▲                                       │     │
│        └───────────────────────────────────────┘     │
│                     │                                │
│              FINAL_ANSWER                            │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐ ┌─────────┐ ┌──────────┐
   │ Tool Reg.  │ │ Memory  │ │  Audit   │
   │ shell_exec │ │ (Redis) │ │   Log    │
   │ web_fetch  │ │ tasks   │ │ actions  │
   │ json_xform │ │ convos  │ │ results  │
   │ + custom   │ │ cache   │ │ timing   │
   └────────────┘ └─────────┘ └──────────┘
```

## Quick Start

```bash
# 1. Clone and install
cp .env.example .env
# Edit .env with your CLAUDE_API_KEY

# 2. Start services
docker-compose up -d   # Redis + (optional) Ollama

# 3. Run the agent
npm install
npm run start:dev

# 4. Test it
curl -X POST http://localhost:3100/api/v1/agent/task \
  -H "Content-Type: application/json" \
  -d '{"input": "List the files in the current directory and tell me the largest one"}'
```

**Swagger docs** → http://localhost:3100/docs

## Project Structure

```
willagent/
├── src/
│   ├── agent/
│   │   ├── agent-orchestrator.service.ts   # ReACT loop engine
│   │   ├── agent.controller.ts             # REST API endpoints
│   │   └── agent.module.ts
│   ├── models/
│   │   ├── model-router.service.ts         # Complexity → provider routing
│   │   ├── model-client.service.ts         # Claude + Ollama API clients
│   │   └── models.module.ts
│   ├── tools/
│   │   ├── tool-registry.service.ts        # Tool management + execution
│   │   ├── builtin-tools.ts                # shell_exec, web_fetch, json_transform
│   │   └── tools.module.ts
│   ├── memory/
│   │   ├── memory.service.ts               # Redis state + audit persistence
│   │   └── memory.module.ts
│   ├── common/
│   │   └── interfaces/
│   │       └── agent.types.ts              # Core type definitions
│   ├── app.module.ts
│   └── main.ts
├── config/
│   └── configuration.ts                    # Validated env config
├── docker/
│   └── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Adding Custom Tools

Create a new tool by implementing the `ToolExecutor` interface:

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ToolExecutor, ToolRegistryService } from '../tools/tool-registry.service';

@Injectable()
export class MyCustomTool implements ToolExecutor, OnModuleInit {
  readonly definition = {
    name: 'my_tool',
    description: 'What this tool does',
    inputSchema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: '...' },
      },
      required: ['param1'],
    },
    sandboxed: false,
    timeout: 10000,
    tags: ['custom'],
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>) {
    // Your logic here
    return { success: true, output: 'result', executionTimeMs: 0 };
  }
}
```

Then add it as a provider in `tools.module.ts`.

## Roadmap

- [ ] Streaming responses via SSE
- [ ] WebSocket support for real-time task updates
- [ ] Docker sandbox for shell_exec (currently direct execution)
- [ ] MCP protocol support for external tool servers
- [ ] Task queue with Bull/BullMQ for background processing
- [ ] Dashboard UI (React) for task monitoring
- [ ] Custom tool: AVAX chain queries
- [ ] Custom tool: GymTech API integration
- [ ] Custom tool: Appliance Consult KB updater
- [ ] Rate limiting middleware
- [ ] Auth layer (JWT / API key)

## Security Notes

- Shell tool has a command blocklist (expandable)
- Redis auth supported via `REDIS_PASSWORD`
- Dockerfile runs as non-root `agent` user
- CORS configurable via `CORS_ORIGINS`
- All tool executions emit audit events
- Designed for eventual Docker sandbox isolation per tool call
