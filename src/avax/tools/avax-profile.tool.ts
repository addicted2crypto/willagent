import { Injectable, OnModuleInit } from '@nestjs/common';
import { ToolRegistryService, ToolExecutor } from '../../tools/tool-registry.service';
import { ToolDefinition, ToolResult } from '../../common/interfaces/agent.types';
import { WalletProfilerService, WalletProfile, WalletType } from '../services/wallet-profiler.service';
import { AvaxRpcService } from '../services/avax-rpc.service';

/**
 * AvaxProfileTool
 *
 * Agent tool for profiling wallets and finding smart money.
 * Actions: profile, buyers, add_known, score
 */
@Injectable()
export class AvaxProfileTool implements ToolExecutor, OnModuleInit {
  readonly definition: ToolDefinition = {
    name: 'avax_profile',
    description:
      'Profile AVAX wallets to find smart money. ' +
      'Actions: profile (analyze a wallet), buyers (find who bought a token), ' +
      'add_known (add wallet identity), list_known (show known wallets).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['profile', 'buyers', 'add_known', 'list_known'],
          description: 'Action to perform',
        },
        address: {
          type: 'string',
          description: 'Wallet or token contract address',
        },
        name: {
          type: 'string',
          description: 'For add_known: name/label for the wallet',
        },
        type: {
          type: 'string',
          enum: ['whale', 'smart_money', 'protocol', 'exchange', 'influencer', 'bot', 'degen'],
          description: 'For add_known: wallet type',
        },
        twitter: {
          type: 'string',
          description: 'For add_known: Twitter handle (without @)',
        },
        blocksBack: {
          type: 'number',
          description: 'For buyers: how many blocks to look back (default: 10000)',
        },
        minBuys: {
          type: 'number',
          description: 'For buyers: minimum buy count to include (default: 1)',
        },
      },
      required: ['action'],
    },
    sandboxed: false,
    timeout: 60000, // 1 minute - profiling can take time
    tags: ['avax', 'wallet', 'profile', 'smart_money'],
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly profiler: WalletProfilerService,
    private readonly rpc: AvaxRpcService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'profile':
          return this.handleProfile(args.address as string);
        case 'buyers':
          return this.handleBuyers(
            args.address as string,
            args.blocksBack as number | undefined,
            args.minBuys as number | undefined,
          );
        case 'add_known':
          return this.handleAddKnown(
            args.address as string,
            args.name as string,
            args.type as WalletType,
            args.twitter as string | undefined,
          );
        case 'list_known':
          return this.handleListKnown();
        default:
          return {
            success: false,
            output: '',
            error: `Unknown action: ${action}. Valid: profile, buyers, add_known, list_known`,
            executionTimeMs: 0,
          };
      }
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `avax_profile error: ${error instanceof Error ? error.message : String(error)}`,
        executionTimeMs: 0,
      };
    }
  }

  // ── Action Handlers ──────────────────────────────────

  private async handleProfile(address?: string): Promise<ToolResult> {
    if (!address) {
      return {
        success: false,
        output: '',
        error: 'Address is required for profile action',
        executionTimeMs: 0,
      };
    }

    const profile = await this.profiler.profileWallet(address);
    const output = this.formatProfile(profile);

    return {
      success: true,
      output,
      metadata: { profile },
      executionTimeMs: 0,
    };
  }

  private async handleBuyers(
    tokenAddress?: string,
    blocksBack?: number,
    minBuys?: number,
  ): Promise<ToolResult> {
    if (!tokenAddress) {
      return {
        success: false,
        output: '',
        error: 'Token contract address is required for buyers action',
        executionTimeMs: 0,
      };
    }

    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = currentBlock - (blocksBack ?? 10000);

    const buyers = await this.profiler.findBuyers(
      tokenAddress,
      fromBlock,
      currentBlock,
      minBuys ?? 1,
    );

    if (buyers.length === 0) {
      return {
        success: true,
        output: `No buyers found for ${tokenAddress} in the last ${blocksBack ?? 10000} blocks`,
        metadata: { buyers: [], count: 0 },
        executionTimeMs: 0,
      };
    }

    // Take top 20
    const topBuyers = buyers.slice(0, 20);
    const lines = topBuyers.map((b, i) => {
      const shortAddr = `${b.address.slice(0, 10)}...${b.address.slice(-8)}`;
      return `${i + 1}. ${shortAddr} - ${b.buyCount} buys`;
    });

    return {
      success: true,
      output: `Top buyers for ${tokenAddress.slice(0, 10)}... (last ${blocksBack ?? 10000} blocks):\n${lines.join('\n')}`,
      metadata: { buyers: topBuyers, count: buyers.length },
      executionTimeMs: 0,
    };
  }

  private async handleAddKnown(
    address?: string,
    name?: string,
    type?: WalletType,
    twitter?: string,
  ): Promise<ToolResult> {
    if (!address || !name || !type) {
      return {
        success: false,
        output: '',
        error: 'Address, name, and type are required for add_known',
        executionTimeMs: 0,
      };
    }

    await this.profiler.addKnownWallet(address, name, type, twitter);

    return {
      success: true,
      output: `Added known wallet:\n  Address: ${address}\n  Name: ${name}\n  Type: ${type}${twitter ? `\n  Twitter: @${twitter}` : ''}`,
      executionTimeMs: 0,
    };
  }

  private async handleListKnown(): Promise<ToolResult> {
    const known = await this.profiler.getKnownWallets();
    const entries = Object.entries(known);

    if (entries.length === 0) {
      return {
        success: true,
        output: 'No known wallets. Use add_known to add some.',
        metadata: { count: 0, wallets: {} },
        executionTimeMs: 0,
      };
    }

    const lines = entries.map(([addr, info]) => {
      const shortAddr = `${addr.slice(0, 10)}...${addr.slice(-8)}`;
      return `  ${info.name} (${info.type}) - ${shortAddr}${info.twitter ? ` @${info.twitter}` : ''}`;
    });

    return {
      success: true,
      output: `Known wallets (${entries.length}):\n${lines.join('\n')}`,
      metadata: { count: entries.length, wallets: known },
      executionTimeMs: 0,
    };
  }

  // ── Formatting ───────────────────────────────────────

  private formatProfile(profile: WalletProfile): string {
    const lines: string[] = [];

    lines.push(`Wallet Profile: ${profile.address.slice(0, 10)}...${profile.address.slice(-8)}`);
    lines.push(`Data Quality: ${profile.dataQuality}`);
    lines.push('');

    // Identity
    if (profile.identity) {
      lines.push(`IDENTITY:`);
      lines.push(`  Name: ${profile.identity.name}`);
      lines.push(`  Type: ${profile.identity.type}`);
      if (profile.identity.twitter) {
        lines.push(`  Twitter: @${profile.identity.twitter}`);
      }
      lines.push('');
    }

    // Stats
    lines.push(`STATS:`);
    lines.push(`  Transactions: ${profile.stats.totalTxCount}`);
    lines.push(`  Unique Tokens: ${profile.stats.uniqueTokensTraded}`);
    if (profile.stats.firstSeenBlock) {
      lines.push(`  First Seen: Block ${profile.stats.firstSeenBlock}`);
    }
    lines.push('');

    // Scores
    lines.push(`SCORES (0-100):`);
    lines.push(`  Smart Money: ${profile.score.smartMoney}`);
    lines.push(`  Activity: ${profile.score.activity}`);
    lines.push(`  Influence: ${profile.score.influence}`);
    lines.push('');

    // Tags
    if (profile.tags.length > 0) {
      lines.push(`TAGS: ${profile.tags.join(', ')}`);
    }

    return lines.join('\n');
  }
}
