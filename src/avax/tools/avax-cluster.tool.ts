import { Injectable, OnModuleInit } from '@nestjs/common';
import { ToolRegistryService, ToolExecutor } from '../../tools/tool-registry.service';
import { ToolDefinition, ToolResult } from '../../common/interfaces/agent.types';
import { WalletClusterService } from '../services/wallet-cluster.service';
import { PortfolioApiService } from '../services/portfolio-api.service';
import { AvaxRpcService } from '../services/avax-rpc.service';
import { IdentityService } from '../services/identity.service';

/**
 * AvaxClusterTool
 *
 * Agent tool for finding wallet clusters - wallets likely owned by the same person.
 * Actions: start, view, evidence, verify, list
 */
@Injectable()
export class AvaxClusterTool implements ToolExecutor, OnModuleInit {
  readonly definition: ToolDefinition = {
    name: 'avax_cluster',
    description:
      'Find wallets likely owned by the same person. ' +
      'Actions: start (begin clustering), view (show cluster), ' +
      'portfolio (FULL value from DeBank including DeFi positions - use this for accurate values!), ' +
      'tokens (ERC20 holdings), identity (ENS/Twitter OSINT), ' +
      'evidence (proof links), verify (confirm member), list (all clusters).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'view', 'portfolio', 'tokens', 'identity', 'evidence', 'verify', 'list'],
          description: 'Action to perform',
        },
        address: {
          type: 'string',
          description: 'Wallet address (for start action)',
        },
        tag: {
          type: 'string',
          description: 'Label for the seed wallet (e.g., "tommy")',
        },
        clusterId: {
          type: 'string',
          description: 'Cluster ID (for view/evidence actions)',
        },
        memberAddress: {
          type: 'string',
          description: 'Member address (for evidence/verify actions)',
        },
        minScore: {
          type: 'number',
          description: 'Minimum connection score (default: 40)',
        },
        deep: {
          type: 'boolean',
          description: 'Enable DEEP mode: analyze ALL counterparties + 2nd-degree connections. Slower but thorough.',
        },
        notes: {
          type: 'string',
          description: 'Verification notes (for verify action, e.g., "Confirmed via Debank - same NFTs")',
        },
      },
      required: ['action'],
    },
    sandboxed: false,
    timeout: 120000, // 2 minutes - clustering takes time
    tags: ['avax', 'wallet', 'cluster', 'forensics'],
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly cluster: WalletClusterService,
    private readonly portfolio: PortfolioApiService,
    private readonly rpc: AvaxRpcService,
    private readonly identity: IdentityService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    const taskId = args._taskId as string | undefined; // Injected by orchestrator

    try {
      switch (action) {
        case 'start':
          return this.handleStart(
            args.address as string,
            args.tag as string,
            args.minScore as number | undefined,
            args.deep as boolean | undefined,
            taskId,
          );
        case 'view':
          return this.handleView(args.clusterId as string);
        case 'portfolio':
          return this.handlePortfolio(args.address as string, args.clusterId as string);
        case 'tokens':
          return this.handleTokens(args.clusterId as string, taskId);
        case 'identity':
          return this.handleIdentity(args.address as string, args.clusterId as string, args.deep as boolean);
        case 'evidence':
          return this.handleEvidence(
            args.clusterId as string,
            args.memberAddress as string,
          );
        case 'verify':
          return this.handleVerify(
            args.clusterId as string,
            args.memberAddress as string,
            args.notes as string | undefined,
          );
        case 'list':
          return this.handleList();
        default:
          return {
            success: false,
            output: '',
            error: `Unknown action: ${action}. Valid: start, view, tokens, identity, evidence, verify, list`,
            executionTimeMs: 0,
          };
      }
    } catch (error) {
      return {
        success: false,
        output: '',
        error: `avax_cluster error: ${error instanceof Error ? error.message : String(error)}`,
        executionTimeMs: 0,
      };
    }
  }

  // ── Action Handlers ──────────────────────────────────────

  private async handleStart(
    address?: string,
    tag?: string,
    minScore?: number,
    deep?: boolean,
    taskId?: string,
  ): Promise<ToolResult> {
    if (!address) {
      return {
        success: false,
        output: '',
        error: 'Address is required for start action',
        executionTimeMs: 0,
      };
    }

    if (!tag) {
      // Generate a tag from the address
      tag = `wallet_${address.slice(2, 8)}`;
    }

    const start = Date.now();
    // Use smart clustering (Snowtrace transfer history)
    // deep=true analyzes ALL counterparties + 2nd-degree connections (thorough but slower)
    // taskId enables progress events to stream to UI
    const cluster = await this.cluster.smartCluster(address, tag, { minScore, deep, taskId });
    const output = this.cluster.formatClusterSummary(cluster);

    return {
      success: true,
      output,
      metadata: {
        clusterId: cluster.id,
        seedWallet: cluster.seedWallet,
        seedTag: cluster.seedTag,
        memberCount: cluster.members.length,
        members: cluster.members.slice(0, 10).map(m => ({
          address: m.address,
          score: m.connection.totalScore,
          confidence: m.connection.confidence,
        })),
      },
      executionTimeMs: Date.now() - start,
    };
  }

  private async handleView(clusterId?: string): Promise<ToolResult> {
    const start = Date.now();

    if (!clusterId) {
      const clusters = await this.cluster.listClusters();
      if (clusters.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No clusters found. Use start action to create one.',
          executionTimeMs: 0,
        };
      }
      clusterId = clusters[clusters.length - 1];
    }

    const cluster = await this.cluster.getCluster(clusterId);
    if (!cluster) {
      return {
        success: false,
        output: '',
        error: `Cluster not found: ${clusterId}`,
        executionTimeMs: 0,
      };
    }

    // Build enhanced output with values and connections
    const lines: string[] = [];
    lines.push(`CLUSTER: ${cluster.seedTag}`);
    lines.push(`Seed: ${cluster.seedWallet}`);
    lines.push('');

    // Get seed wallet value
    const seedPortfolio = await this.portfolio.getDebankPortfolio(cluster.seedWallet);
    const seedShort = `${cluster.seedWallet.slice(0, 10)}...${cluster.seedWallet.slice(-6)}`;
    lines.push(`[SEED] ${seedShort}`);
    lines.push(`  Value: $${seedPortfolio.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    if (seedPortfolio.protocols.length > 0) {
      lines.push(`  Top DeFi: ${seedPortfolio.protocols[0].name} ($${seedPortfolio.protocols[0].usd.toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
    }
    lines.push('');

    if (cluster.members.length === 0) {
      lines.push('No related wallets found.');
    } else {
      lines.push(`CONNECTED WALLETS (${cluster.members.length}):`);
      lines.push('');

      let clusterTotal = seedPortfolio.totalUsd;

      // Show top members with values and connections
      for (let i = 0; i < Math.min(cluster.members.length, 5); i++) {
        const m = cluster.members[i];
        const shortAddr = `${m.address.slice(0, 10)}...${m.address.slice(-6)}`;

        // Get this wallet's value
        const memberPortfolio = await this.portfolio.getDebankPortfolio(m.address);
        clusterTotal += memberPortfolio.totalUsd;

        // Build connection reason from evidence
        const reasons: string[] = [];
        const hasBidirectional = m.connection.evidence.some(e => e.description.includes('BIDIRECTIONAL'));
        if (hasBidirectional) reasons.push('BIDIRECTIONAL');
        if (m.connection.scores.sameFunder > 0) reasons.push('SAME_FUNDER');
        if (m.connection.scores.recipientOverlap > 0 && !hasBidirectional) reasons.push('TRANSFERS');
        if (m.connection.scores.tokenOverlap > 0) reasons.push('SHARED_TOKENS');

        const verified = m.verified ? ' [VERIFIED]' : '';
        const reasonStr = reasons.length > 0 ? reasons.join(' + ') : 'CONNECTED';

        lines.push(`[${i + 1}] ${shortAddr}${verified}`);
        lines.push(`  Value: $${memberPortfolio.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        lines.push(`  Connection: ${reasonStr} (score: ${m.connection.totalScore})`);

        // Show key evidence
        if (m.connection.evidence.length > 0) {
          const topEvidence = m.connection.evidence[0];
          lines.push(`  Evidence: ${topEvidence.description}`);
        }
        lines.push('');
      }

      lines.push(`CLUSTER TOTAL VALUE: $${clusterTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    }

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        clusterId: cluster.id,
        seedWallet: cluster.seedWallet,
        seedTag: cluster.seedTag,
        memberCount: cluster.members.length,
        seedValue: seedPortfolio.totalUsd,
      },
      executionTimeMs: Date.now() - start,
    };
  }

  private async handleEvidence(
    clusterId?: string,
    memberAddress?: string,
  ): Promise<ToolResult> {
    if (!clusterId) {
      const clusters = await this.cluster.listClusters();
      if (clusters.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No clusters found.',
          executionTimeMs: 0,
        };
      }
      clusterId = clusters[clusters.length - 1];
    }

    const cluster = await this.cluster.getCluster(clusterId);
    if (!cluster) {
      return {
        success: false,
        output: '',
        error: `Cluster not found: ${clusterId}`,
        executionTimeMs: 0,
      };
    }

    // If no member specified, show evidence for top member
    let member = cluster.members[0];
    if (memberAddress) {
      const found = cluster.members.find(
        m => m.address.toLowerCase() === memberAddress.toLowerCase(),
      );
      if (!found) {
        return {
          success: false,
          output: '',
          error: `Member ${memberAddress} not found in cluster`,
          executionTimeMs: 0,
        };
      }
      member = found;
    }

    if (!member) {
      return {
        success: false,
        output: '',
        error: 'No members in cluster to show evidence for',
        executionTimeMs: 0,
      };
    }

    const output = this.cluster.formatEvidence(member);

    return {
      success: true,
      output,
      metadata: {
        clusterId: cluster.id,
        memberAddress: member.address,
        evidence: member.connection.evidence,
      },
      executionTimeMs: 0,
    };
  }

  private async handleVerify(
    clusterId?: string,
    memberAddress?: string,
    notes?: string,
  ): Promise<ToolResult> {
    if (!memberAddress) {
      return {
        success: false,
        output: '',
        error: 'memberAddress is required for verify action',
        executionTimeMs: 0,
      };
    }

    if (!clusterId) {
      const clusters = await this.cluster.listClusters();
      if (clusters.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No clusters found.',
          executionTimeMs: 0,
        };
      }
      clusterId = clusters[clusters.length - 1];
    }

    const start = Date.now();
    const success = await this.cluster.verifyMember(clusterId, memberAddress, notes);

    if (!success) {
      return {
        success: false,
        output: '',
        error: `Failed to verify member. Check cluster ID and address.`,
        executionTimeMs: Date.now() - start,
      };
    }

    const output = [
      `[OK] Verified member ${memberAddress.slice(0, 10)}...${memberAddress.slice(-6)}`,
      notes ? `Notes: ${notes}` : '',
      `Cluster: ${clusterId}`,
    ].filter(Boolean).join('\n');

    return {
      success: true,
      output,
      metadata: {
        clusterId,
        memberAddress,
        verified: true,
        notes,
      },
      executionTimeMs: Date.now() - start,
    };
  }

  private async handleList(): Promise<ToolResult> {
    const clusterIds = await this.cluster.listClusters();

    if (clusterIds.length === 0) {
      return {
        success: true,
        output: 'No clusters found. Use start action to create one.',
        metadata: { count: 0, clusters: [] },
        executionTimeMs: 0,
      };
    }

    const lines: string[] = [`Found ${clusterIds.length} cluster(s):`];

    for (const id of clusterIds) {
      const cluster = await this.cluster.getCluster(id);
      if (cluster) {
        const verified = cluster.members.filter(m => m.verified).length;
        const verifiedStr = verified > 0 ? `, ${verified} verified` : '';
        lines.push(`  ${id}: ${cluster.seedTag} (${cluster.members.length} members${verifiedStr})`);
      }
    }

    return {
      success: true,
      output: lines.join('\n'),
      metadata: { count: clusterIds.length, clusters: clusterIds },
      executionTimeMs: 0,
    };
  }

  /**
   * Analyze ERC20 tokens across all wallets in a cluster
   * Shows common tokens, recent activity, and tokens to watch
   */
  private async handleTokens(clusterId?: string, taskId?: string): Promise<ToolResult> {
    if (!clusterId) {
      const clusters = await this.cluster.listClusters();
      if (clusters.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No clusters found.',
          executionTimeMs: 0,
        };
      }
      clusterId = clusters[clusters.length - 1];
    }

    const cluster = await this.cluster.getCluster(clusterId);
    if (!cluster) {
      return {
        success: false,
        output: '',
        error: `Cluster not found: ${clusterId}`,
        executionTimeMs: 0,
      };
    }

    const start = Date.now();
    const allWallets = [cluster.seedWallet, ...cluster.members.map(m => m.address)];

    // Aggregate token transfers across all wallets
    const tokenMap = new Map<string, {
      contract: string;
      symbol: string;
      walletCount: number;
      wallets: Set<string>;
      totalTxns: number;
      recentTxns: Array<{ wallet: string; type: 'in' | 'out'; value: string; timestamp: number }>;
    }>();

    for (const wallet of allWallets.slice(0, 10)) { // Limit to 10 wallets for speed
      const transfers = await this.portfolio.getTokenTransfers(wallet);

      for (const tx of transfers) {
        if (!tx.tokenContract || !tx.tokenSymbol) continue;

        const key = tx.tokenContract.toLowerCase();
        let token = tokenMap.get(key);
        if (!token) {
          token = {
            contract: tx.tokenContract,
            symbol: tx.tokenSymbol,
            walletCount: 0,
            wallets: new Set(),
            totalTxns: 0,
            recentTxns: [],
          };
          tokenMap.set(key, token);
        }

        if (!token.wallets.has(wallet)) {
          token.wallets.add(wallet);
          token.walletCount++;
        }
        token.totalTxns++;

        // Track recent transactions (last 5 per token)
        if (token.recentTxns.length < 5) {
          token.recentTxns.push({
            wallet: wallet,
            type: tx.from.toLowerCase() === wallet.toLowerCase() ? 'out' : 'in',
            value: tx.valueFormatted,
            timestamp: tx.timestamp,
          });
        }
      }
    }

    // Sort by wallet count (tokens held by multiple wallets are more interesting)
    const sortedTokens = Array.from(tokenMap.values())
      .filter(t => t.walletCount > 1) // Only tokens held by multiple wallets
      .sort((a, b) => b.walletCount - a.walletCount);

    // Format output
    const lines: string[] = [];
    lines.push(`Token Analysis for Cluster: ${cluster.seedTag}`);
    lines.push(`Wallets analyzed: ${Math.min(allWallets.length, 10)}`);
    lines.push('');

    if (sortedTokens.length === 0) {
      lines.push('No common tokens found across cluster wallets.');
    } else {
      lines.push(`COMMON TOKENS (held by 2+ wallets):`);
      lines.push('');

      for (const token of sortedTokens.slice(0, 15)) {
        const walletList = Array.from(token.wallets).map(w => `${w.slice(0, 6)}...${w.slice(-4)}`).join(', ');
        lines.push(`${token.symbol} (${token.contract})`);
        lines.push(`  Wallets: ${token.walletCount} [${walletList}]`);
        lines.push(`  Total txns: ${token.totalTxns}`);
        lines.push(`  Snowtrace: https://snowtrace.io/token/${token.contract}`);
        lines.push('');
      }
    }

    // Find tokens to watch (high activity, recently bought)
    const recentBuys = Array.from(tokenMap.values())
      .flatMap(t => t.recentTxns.filter(tx => tx.type === 'in'))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    if (recentBuys.length > 0) {
      lines.push('RECENT BUYS (tokens to watch):');
      for (const buy of recentBuys) {
        const token = Array.from(tokenMap.values()).find(t =>
          t.recentTxns.some(tx => tx === buy)
        );
        if (token) {
          const shortWallet = `${buy.wallet.slice(0, 6)}...${buy.wallet.slice(-4)}`;
          const date = new Date(buy.timestamp).toLocaleDateString();
          lines.push(`  ${token.symbol}: ${buy.value} by ${shortWallet} (${date})`);
        }
      }
    }

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        clusterId: cluster.id,
        walletsAnalyzed: Math.min(allWallets.length, 10),
        commonTokens: sortedTokens.length,
        tokens: sortedTokens.slice(0, 10).map(t => ({
          symbol: t.symbol,
          contract: t.contract,
          walletCount: t.walletCount,
        })),
      },
      executionTimeMs: Date.now() - start,
    };
  }

  /**
   * Lookup identity for a wallet address or all wallets in a cluster
   * Checks ENS, DeBank, known labels, AND web search OSINT by default
   * Set deep=false to skip web search (faster but less thorough)
   */
  private async handleIdentity(
    address?: string,
    clusterId?: string,
    deep?: boolean,
  ): Promise<ToolResult> {
    const start = Date.now();
    // Web search is ON by default unless explicitly disabled
    const doWebSearch = deep !== false;

    // If address provided, lookup single wallet
    if (address) {
      // Always do deep lookup (includes web search OSINT) unless deep=false
      const identityResult = doWebSearch
        ? await this.identity.deepLookupIdentity(address)
        : await this.identity.lookupIdentity(address);

      const lines: string[] = [];
      lines.push(this.identity.formatIdentity(identityResult));

      // Show web search results if available
      if ('webSearch' in identityResult && identityResult.webSearch) {
        const webSearch = identityResult.webSearch as { possibleTwitters: string[]; searchResults: string[] };
        if (webSearch.possibleTwitters.length > 0 || webSearch.searchResults.length > 0) {
          lines.push('');
          lines.push('WEB SEARCH OSINT:');
          if (webSearch.possibleTwitters.length > 0) {
            lines.push(`  Possible Twitter: ${webSearch.possibleTwitters.join(', ')}`);
          }
          if (webSearch.searchResults.length > 0) {
            lines.push('  Search hits:');
            for (const snippet of webSearch.searchResults.slice(0, 3)) {
              lines.push(`    - ${snippet.slice(0, 80)}...`);
            }
          }
        }
      }

      return {
        success: true,
        output: lines.join('\n'),
        metadata: {
          address: identityResult.address,
          ens: identityResult.ens,
          twitter: identityResult.twitter,
          debank: identityResult.debank,
          labels: identityResult.labels,
          sources: identityResult.sources,
          webSearch: 'webSearch' in identityResult ? identityResult.webSearch : undefined,
        },
        executionTimeMs: Date.now() - start,
      };
    }

    // If clusterId provided (or default to latest), lookup all cluster wallets
    if (!clusterId) {
      const clusters = await this.cluster.listClusters();
      if (clusters.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No clusters found. Provide an address or create a cluster first.',
          executionTimeMs: 0,
        };
      }
      clusterId = clusters[clusters.length - 1];
    }

    const cluster = await this.cluster.getCluster(clusterId);
    if (!cluster) {
      return {
        success: false,
        output: '',
        error: `Cluster not found: ${clusterId}`,
        executionTimeMs: 0,
      };
    }

    // Lookup identities for all wallets in cluster
    const allAddresses = [cluster.seedWallet, ...cluster.members.map(m => m.address)];
    const identities = await this.identity.lookupIdentities(allAddresses);

    const lines: string[] = [];
    lines.push(`Identity Lookup for Cluster: ${cluster.seedTag}`);
    lines.push(`Wallets checked: ${allAddresses.length}`);
    lines.push('');

    let foundIdentities = 0;
    for (const [addr, id] of identities) {
      if (id.sources.length > 0) {
        foundIdentities++;
        lines.push(this.identity.formatIdentity(id));
        lines.push('');
      }
    }

    if (foundIdentities === 0) {
      lines.push('No identities found for any wallets in this cluster.');
    } else {
      lines.push(`Found identities for ${foundIdentities}/${allAddresses.length} wallets.`);
    }

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        clusterId: cluster.id,
        walletsChecked: allAddresses.length,
        identitiesFound: foundIdentities,
        identities: Array.from(identities.entries()).map(([addr, id]) => ({
          address: addr,
          ens: id.ens,
          labels: id.labels,
        })),
      },
      executionTimeMs: Date.now() - start,
    };
  }

  /**
   * Get FULL portfolio value from DeBank including DeFi positions
   * This shows the REAL total value, not just wallet tokens
   */
  private async handlePortfolio(
    address?: string,
    clusterId?: string,
  ): Promise<ToolResult> {
    const start = Date.now();

    // If address provided, get portfolio for single wallet
    if (address) {
      const portfolio = await this.portfolio.getDebankPortfolio(address);
      const output = this.portfolio.formatDebankPortfolio(portfolio);

      return {
        success: true,
        output: `Portfolio for ${address.slice(0, 10)}...${address.slice(-6)}:\n\n${output}`,
        metadata: {
          address,
          totalUsd: portfolio.totalUsd,
          protocols: portfolio.protocols,
          topTokens: portfolio.topTokens,
        },
        executionTimeMs: Date.now() - start,
      };
    }

    // If clusterId provided (or default to latest), get portfolio for all wallets
    if (!clusterId) {
      const clusters = await this.cluster.listClusters();
      if (clusters.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No clusters found. Provide an address or create a cluster first.',
          executionTimeMs: 0,
        };
      }
      clusterId = clusters[clusters.length - 1];
    }

    const cluster = await this.cluster.getCluster(clusterId);
    if (!cluster) {
      return {
        success: false,
        output: '',
        error: `Cluster not found: ${clusterId}`,
        executionTimeMs: 0,
      };
    }

    // Get portfolio for all wallets in cluster
    const allAddresses = [cluster.seedWallet, ...cluster.members.map(m => m.address)];
    const lines: string[] = [];
    let clusterTotalUsd = 0;

    lines.push(`Portfolio Summary for Cluster: ${cluster.seedTag}`);
    lines.push(`Wallets: ${allAddresses.length}`);
    lines.push('');

    for (const addr of allAddresses.slice(0, 5)) { // Limit to 5 to avoid rate limits
      const shortAddr = `${addr.slice(0, 10)}...${addr.slice(-6)}`;
      const portfolio = await this.portfolio.getDebankPortfolio(addr);
      clusterTotalUsd += portfolio.totalUsd;

      if (portfolio.totalUsd > 0) {
        lines.push(`${shortAddr}: $${portfolio.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        if (portfolio.protocols.length > 0) {
          const topProtocol = portfolio.protocols[0];
          lines.push(`  Top: ${topProtocol.name} ($${topProtocol.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
        }
      } else {
        lines.push(`${shortAddr}: $0`);
      }
    }

    lines.push('');
    lines.push(`CLUSTER TOTAL: $${clusterTotalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        clusterId: cluster.id,
        walletsChecked: Math.min(allAddresses.length, 5),
        clusterTotalUsd,
      },
      executionTimeMs: Date.now() - start,
    };
  }
}
