# AnonAgent

Self-hosted on-chain intelligence terminal with multi-model AI routing, live token monitoring, and wallet analysis — built for AVAX and EVM chains.

> Own your data pipeline. No third-party surveillance. Full control over model routing and tooling.

---

## What it does

AnonAgent gives you a command-driven terminal for real-time on-chain research:

- **Token pulse** — live price, market cap, liquidity, and recent buys updating every 30s
- **Token discovery** — scan hot tokens, find who bought, trace wallet connections
- **Wallet intelligence** — cluster related wallets, score behaviour, tag and track
- **Smart routing** — simple queries hit a local model; complex analysis escalates automatically

---

## Token Discovery Flow

```
scan                        → surface trending tokens on-chain
who_bought <token>          → find recent buyers by address
connected <wallet1> <wallet2>  → are these the same person?
inspect <token|address>     → deep score — liquidity, volume, wallet quality
```

---

## Live Pulse

```
watch <0x token address>    → stream price + Market Cap + buys every 30s (updates in-place)
unwatch all
```

Output:
```
PULSE:TOKEN
TOKEN  WAVAX/TOKEN · Pharaoh  $0.1393  |  1h: -0.90%  |  24h: +3.47%
MC: $1.24M  (19.6x liq)  |  Liq: $63.5k  |  Vol24h: $27.3k  |  Buys/Sells: 80/170

Recent buys (30m) — 3 txs:
  0x4a3f…c927  $1.2k  (8,612 TOKEN)  4m ago   tx↗  🐦  [copy]
  0x9b12…f401  $390   (2,800 TOKEN)  11m ago  tx↗  🐦  [copy]
```

---

## Wallet Commands

```
sleuth <address|alias>      → fast identity lookup — ENS, labels, tier, intel links
buyers <token address>      → who bought this token recently
connected <w1> <w2>         → verify if two wallets are linked
tag <address> <name>        → save a wallet alias
<alias>                     → cluster analysis for any saved wallet alias
```

---

## Model Routing

Three-tier routing keeps costs low and latency fast:

| Signal strength | Model |
|----------------|-------|
| Simple lookups, price checks | Local (Ollama / vLLM) |
| Wallet analysis, token scoring | Turbo (GPT-class remote) |
| Critical signals, deep reasoning | Claude (Anthropic API) |

The agent escalates automatically based on signal strength — most queries never leave your machine.

---

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
# Add your API keys — see .env.example for required vars

# 2. Start the server
npm install
npm run start:dev

# 3. Open the terminal
open http://localhost:3100
```

Redis is optional — falls back to in-memory for development.

---

## Stack

- **NestJS + TypeScript** — modular backend, pluggable skill system
- **DexScreener API** — token discovery and market data
- **Routescan API** — on-chain transaction history (AVAX, ETH, BSC, Base, Polygon, Arbitrum)
- **Redis** — state, caching, event bus
- **PostgreSQL** — wallet graph and scoring persistence
- **Local + remote LLMs** — via OpenWebUI-compatible endpoint

---

## Adding Tools

Implement the `ToolExecutor` interface and register with the tool registry:

```typescript
@Injectable()
export class MyTool implements ToolExecutor, OnModuleInit {
  readonly definition = {
    name: 'my_tool',
    description: 'What this tool does',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };

  constructor(private readonly registry: ToolRegistryService) {}
  onModuleInit() { this.registry.register(this); }

  async execute(args: Record<string, unknown>) {
    return { success: true, output: '...' };
  }
}
```

---

## Security

- Secrets in `.env` only — never committed
- Redis auth supported
- All tool executions are audit-logged
- Designed for self-hosted, air-gapped deployments

---

## Status

Active development. AVAX chain support is primary; other EVM chains available via the pulse endpoint.
