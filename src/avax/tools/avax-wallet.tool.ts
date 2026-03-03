import { Injectable, OnModuleInit } from '@nestjs/common';
import { ToolRegistryService, ToolExecutor } from '../../tools/tool-registry.service';
import { ToolDefinition, ToolResult } from '../../common/interfaces/agent.types';
import { WalletTrackerService } from '../services/wallet-tracker.service';
import { AvaxRpcService } from '../services/avax-rpc.service';

/**
 * AvaxWalletTool
 *
 * Agent tool for tracking and querying AVAX wallets.
 * Actions: track, untrack, list, balance, activity
 */
@Injectable()
export class AvaxWalletTool implements ToolExecutor, OnModuleInit {
  readonly definition: ToolDefinition = {
    name: 'avax_wallet',
    description:
      'Track and query AVAX C-Chain wallets. ' +
      'Actions: track (add wallet with tag), untrack (remove), list (show all tracked), ' +
      'balance (get AVAX + token balances), activity (recent transfers).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['track', 'untrack', 'list', 'balance', 'activity'],
          description: 'Action to perform',
        },
        address: {
          type: 'string',
          description: 'Wallet address (0x...) or tag name for balance/activity',
        },
        tag: {
          type: 'string',
          description: 'Label for the wallet (for track action)',
        },
        notes: {
          type: 'string',
          description: 'Optional notes about the wallet',
        },
        blocks: {
          type: 'number',
          description: 'Number of blocks to look back for activity (default: 1000)',
        },
      },
      required: ['action'],
    },
    sandboxed: false,
    timeout: 30000,
    tags: ['avax', 'wallet', 'crypto', 'blockchain'],
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly walletTracker: WalletTrackerService,
    private readonly rpc: AvaxRpcService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    const address = args.address as string | undefined;
    const tag = args.tag as string | undefined;
    const notes = args.notes as string | undefined;
    const blocks = (args.blocks as number) ?? 1000;

    try {
      switch (action) {
        case 'track':
          return this.handleTrack(address, tag, notes);
        case 'untrack':
          return this.handleUntrack(address);
        case 'list':
          return this.handleList();
        case 'balance':
          return this.handleBalance(address);
        case 'activity':
          return this.handleActivity(address, blocks);
        default:
          return {
            success: false,
            output: '',
            error: `Unknown action: ${action}. Valid: track, untrack, list, balance, activity`,
            executionTimeMs: 0,
          };
      }
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `avax_wallet error: ${error instanceof Error ? error.message : String(error)}`,
        executionTimeMs: 0,
      };
    }
  }

  // ── Action Handlers ──────────────────────────────────

  private async handleTrack(
    address?: string,
    tag?: string,
    notes?: string,
  ): Promise<ToolResult> {
    if (!address) {
      return {
        success: false,
        output: '',
        error: 'Address is required for track action',
        executionTimeMs: 0,
      };
    }

    if (!tag) {
      return {
        success: false,
        output: '',
        error: 'Tag is required for track action',
        executionTimeMs: 0,
      };
    }

    if (!address.startsWith('0x') || address.length !== 42) {
      return {
        success: false,
        output: '',
        error: 'Invalid address format. Expected 0x... (42 characters)',
        executionTimeMs: 0,
      };
    }

    const wallet = await this.walletTracker.trackWallet(address, tag, notes);

    return {
      success: true,
      output: `Tracking wallet:\n  Address: ${wallet.address}\n  Tag: ${wallet.tag}${wallet.notes ? `\n  Notes: ${wallet.notes}` : ''}`,
      metadata: { wallet },
      executionTimeMs: 0,
    };
  }

  private async handleUntrack(address?: string): Promise<ToolResult> {
    if (!address) {
      return {
        success: false,
        output: '',
        error: 'Address is required for untrack action',
        executionTimeMs: 0,
      };
    }

    const removed = await this.walletTracker.untrackWallet(address);

    if (!removed) {
      return {
        success: false,
        output: '',
        error: `Wallet ${address} was not being tracked`,
        executionTimeMs: 0,
      };
    }

    return {
      success: true,
      output: `Stopped tracking wallet: ${address}`,
      executionTimeMs: 0,
    };
  }

  private async handleList(): Promise<ToolResult> {
    const wallets = await this.walletTracker.listWallets();

    if (wallets.length === 0) {
      return {
        success: true,
        output: 'No wallets being tracked. Use action=track to add one.',
        metadata: { count: 0, wallets: [] },
        executionTimeMs: 0,
      };
    }

    const lines = wallets.map((w, i) => {
      const age = this.formatAge(Date.now() - w.createdAt);
      return `${i + 1}. [${w.tag}] ${w.address.slice(0, 10)}...${w.address.slice(-8)} (tracked ${age})`;
    });

    return {
      success: true,
      output: `Tracked wallets (${wallets.length}):\n${lines.join('\n')}`,
      metadata: { count: wallets.length, wallets },
      executionTimeMs: 0,
    };
  }

  private async handleBalance(addressOrTag?: string): Promise<ToolResult> {
    if (!addressOrTag) {
      return {
        success: false,
        output: '',
        error: 'Address or tag is required for balance action',
        executionTimeMs: 0,
      };
    }

    const balance = await this.walletTracker.getBalance(addressOrTag);

    if (!balance) {
      return {
        success: false,
        output: '',
        error: `Could not find wallet: ${addressOrTag}`,
        executionTimeMs: 0,
      };
    }

    let output = `Balance for ${balance.address}:\n  AVAX: ${balance.avaxFormatted}`;

    if (balance.tokens.length > 0) {
      output += '\n  Tokens:';
      for (const token of balance.tokens) {
        output += `\n    ${token.symbol}: ${token.balanceFormatted}`;
      }
    } else {
      output += '\n  No token balances found in well-known tokens';
    }

    return {
      success: true,
      output,
      metadata: { balance },
      executionTimeMs: 0,
    };
  }

  private async handleActivity(addressOrTag?: string, blocks?: number): Promise<ToolResult> {
    if (!addressOrTag) {
      return {
        success: false,
        output: '',
        error: 'Address or tag is required for activity action',
        executionTimeMs: 0,
      };
    }

    let address = addressOrTag;

    // Resolve tag to address
    if (!addressOrTag.startsWith('0x')) {
      const wallet = await this.walletTracker.getWalletByTag(addressOrTag);
      if (!wallet) {
        return {
          success: false,
          output: '',
          error: `Could not find wallet with tag: ${addressOrTag}`,
          executionTimeMs: 0,
        };
      }
      address = wallet.address;
    }

    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = currentBlock - (blocks ?? 1000);

    const transfers = await this.rpc.getTransfers(address, fromBlock);

    if (transfers.length === 0) {
      return {
        success: true,
        output: `No token transfers found in last ${blocks ?? 1000} blocks for ${address}`,
        metadata: { transfers: [], count: 0 },
        executionTimeMs: 0,
      };
    }

    const lines = transfers.slice(0, 20).map(t => {
      const direction = t.to.toLowerCase() === address.toLowerCase() ? 'IN' : 'OUT';
      const other = direction === 'IN' ? t.from : t.to;
      return `  [${direction}] ${t.contractAddress.slice(0, 10)}... block ${t.blockNumber} ${direction === 'IN' ? 'from' : 'to'} ${other.slice(0, 10)}...`;
    });

    return {
      success: true,
      output: `Recent activity for ${address} (last ${blocks ?? 1000} blocks):\n${lines.join('\n')}${transfers.length > 20 ? `\n  ... and ${transfers.length - 20} more` : ''}`,
      metadata: { transfers, count: transfers.length },
      executionTimeMs: 0,
    };
  }

  // ── Helpers ──────────────────────────────────────────

  private formatAge(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
