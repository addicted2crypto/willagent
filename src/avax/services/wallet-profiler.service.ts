import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MemoryService } from '../../memory/memory.service';
import { AvaxRpcService } from './avax-rpc.service';
import { TokenTransfer, AVAX_CONSTANTS } from '../interfaces/avax.types';

/**
 * Wallet profile with scoring and identity info
 */
export interface WalletProfile {
  address: string;

  // Identity (if known)
  identity?: {
    name?: string;           // Known name/label
    twitter?: string;        // Twitter handle
    type?: WalletType;       // whale, protocol, exchange, etc.
    source?: string;         // Where we got this info
  };

  // On-chain stats
  stats: {
    totalTxCount: number;
    uniqueTokensTraded: number;
    firstSeenBlock?: number;
    lastActiveBlock?: number;
    avgHoldTime?: number;    // Average time holding tokens (blocks)
  };

  // Trading performance
  performance: {
    earlyCalls: number;      // Times bought before major pump
    winRate?: number;        // % of profitable trades (if calculable)
    avgEntryTiming?: number; // How early they typically enter (0-100, 100 = first)
  };

  // Scoring
  score: {
    smartMoney: number;      // 0-100 likelihood of being smart money
    activity: number;        // 0-100 how active
    influence: number;       // 0-100 potential influence (big wallet, known identity)
  };

  // Tags
  tags: WalletTag[];

  // Metadata
  profiledAt: number;
  dataQuality: 'high' | 'medium' | 'low';
}

export type WalletType =
  | 'whale'           // Large holder
  | 'smart_money'     // Consistently early
  | 'protocol'        // DeFi protocol
  | 'exchange'        // CEX/DEX
  | 'influencer'      // Known public figure
  | 'bot'             // MEV/arbitrage bot
  | 'degen'           // High frequency, mixed results
  | 'unknown';

export type WalletTag =
  | 'early_buyer'     // Often buys before pumps
  | 'whale'           // >$100k holdings
  | 'active'          // >100 tx/month
  | 'diamond_hands'   // Holds long term
  | 'flipper'         // Quick in/out
  | 'verified'        // Known identity
  | 'suspicious'      // Potential wash trading
  | 'new_wallet';     // Created recently

/**
 * Known wallet labels (public addresses)
 * This will grow as we discover more
 */
const KNOWN_WALLETS: Record<string, { name: string; type: WalletType; twitter?: string }> = {
  // Exchanges
  '0x9f8c163cba728e99993abe7495f06c0a3c8ac8b9': { name: 'Binance', type: 'exchange' },
  '0xe0e4d6ec96f11fc1cdde1e7a3146a16ed8d5c8c8': { name: 'Trader Joe', type: 'protocol' },

  // Add more as we discover them - this is the knowledge base!
};

/**
 * WalletProfilerService
 *
 * Analyzes wallet behavior and attempts to identify who's behind it.
 * Scores wallets based on trading performance and activity patterns.
 */
@Injectable()
export class WalletProfilerService implements OnModuleInit {
  private readonly logger = new Logger(WalletProfilerService.name);
  private readonly PROFILE_PREFIX = 'avax:profile:';

  constructor(
    private readonly memory: MemoryService,
    private readonly rpc: AvaxRpcService,
  ) {}

  async onModuleInit() {
    this.logger.log(`Wallet profiler initialized with ${Object.keys(KNOWN_WALLETS).length} known wallets`);
  }

  /**
   * Profile a wallet - analyze their on-chain behavior and score them
   */
  async profileWallet(address: string, options?: {
    blocksToAnalyze?: number;
    forceRefresh?: boolean;
  }): Promise<WalletProfile> {
    const normalized = address.toLowerCase();
    const blocksToAnalyze = options?.blocksToAnalyze ?? 50000; // ~1 week

    // Check cache unless force refresh
    if (!options?.forceRefresh) {
      const cached = await this.getCachedProfile(normalized);
      if (cached) return cached;
    }

    this.logger.debug(`Profiling wallet: ${normalized}`);

    // Check if wallet is known
    const knownInfo = KNOWN_WALLETS[normalized];

    // Get on-chain data
    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = currentBlock - blocksToAnalyze;
    const transfers = await this.rpc.getTransfers(normalized, fromBlock);

    // Analyze transfers
    const stats = this.analyzeTransfers(transfers, normalized);
    const performance = this.analyzePerformance(transfers, normalized);
    const score = this.calculateScores(stats, performance, knownInfo);
    const tags = this.generateTags(stats, performance, score, knownInfo);

    const profile: WalletProfile = {
      address: normalized,
      identity: knownInfo ? {
        name: knownInfo.name,
        twitter: knownInfo.twitter,
        type: knownInfo.type,
        source: 'known_wallets',
      } : undefined,
      stats,
      performance,
      score,
      tags,
      profiledAt: Date.now(),
      dataQuality: transfers.length > 100 ? 'high' : transfers.length > 20 ? 'medium' : 'low',
    };

    // Cache the profile
    await this.cacheProfile(profile);

    return profile;
  }

  /**
   * Add a known wallet to our database
   */
  async addKnownWallet(
    address: string,
    name: string,
    type: WalletType,
    twitter?: string,
  ): Promise<void> {
    const normalized = address.toLowerCase();
    const key = `avax:known:${normalized}`;

    await this.memory.setCache(key, JSON.stringify({ name, type, twitter }));
    this.logger.log(`Added known wallet: ${name} (${normalized})`);
  }

  /**
   * Get all known wallets
   */
  async getKnownWallets(): Promise<Record<string, { name: string; type: WalletType; twitter?: string }>> {
    // Start with built-in known wallets
    const result = { ...KNOWN_WALLETS };

    // TODO: Load from memory/DB
    // For now just return built-in ones

    return result;
  }

  /**
   * Find wallets that bought a token in a block range
   */
  async findBuyers(
    tokenContract: string,
    fromBlock: number,
    toBlock?: number,
    minTransfers = 1,
  ): Promise<Array<{ address: string; buyCount: number; totalValue: string }>> {
    const paddedToken = '0x' + tokenContract.toLowerCase().replace('0x', '').padStart(64, '0');
    const toBlockHex = toBlock ? '0x' + toBlock.toString(16) : 'latest';

    // Get all Transfer events for this token
    const logs = await this.rpc['rpcCall']<Array<{
      topics: string[];
      data: string;
    }>>('eth_getLogs', [{
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: toBlockHex,
      address: tokenContract,
      topics: [AVAX_CONSTANTS.TOPICS.Transfer],
    }]);

    // Count buys per address (receiving transfers)
    const buyerMap = new Map<string, { count: number; totalValue: bigint }>();

    for (const log of logs) {
      const to = '0x' + log.topics[2].slice(26).toLowerCase();
      const value = BigInt(log.data);

      const existing = buyerMap.get(to) ?? { count: 0, totalValue: 0n };
      buyerMap.set(to, {
        count: existing.count + 1,
        totalValue: existing.totalValue + value,
      });
    }

    // Filter and sort by count
    const buyers = Array.from(buyerMap.entries())
      .filter(([_, data]) => data.count >= minTransfers)
      .map(([address, data]) => ({
        address,
        buyCount: data.count,
        totalValue: data.totalValue.toString(),
      }))
      .sort((a, b) => b.buyCount - a.buyCount);

    return buyers;
  }

  // ── Analysis Methods ─────────────────────────────────

  private analyzeTransfers(
    transfers: TokenTransfer[],
    walletAddress: string,
  ): WalletProfile['stats'] {
    const uniqueTokens = new Set(transfers.map(t => t.contractAddress));
    const blocks = transfers.map(t => t.blockNumber).sort((a, b) => a - b);

    return {
      totalTxCount: transfers.length,
      uniqueTokensTraded: uniqueTokens.size,
      firstSeenBlock: blocks[0],
      lastActiveBlock: blocks[blocks.length - 1],
    };
  }

  private analyzePerformance(
    transfers: TokenTransfer[],
    walletAddress: string,
  ): WalletProfile['performance'] {
    // Group transfers by token
    const tokenActivity = new Map<string, { buys: number[]; sells: number[] }>();

    for (const t of transfers) {
      const isReceiving = t.to.toLowerCase() === walletAddress.toLowerCase();

      if (!tokenActivity.has(t.contractAddress)) {
        tokenActivity.set(t.contractAddress, { buys: [], sells: [] });
      }

      const activity = tokenActivity.get(t.contractAddress)!;
      if (isReceiving) {
        activity.buys.push(t.blockNumber);
      } else {
        activity.sells.push(t.blockNumber);
      }
    }

    // Calculate how early they typically buy
    // For now, simple heuristic: lower block numbers = earlier
    let earlyCalls = 0;

    // This is a placeholder - real implementation would compare
    // their buy blocks to when the token "mooned"
    for (const [_, activity] of tokenActivity) {
      if (activity.buys.length > 0 && activity.sells.length > 0) {
        // They both bought and sold - check if profitable timing
        const firstBuy = Math.min(...activity.buys);
        const lastSell = Math.max(...activity.sells);
        if (lastSell > firstBuy) {
          // Simplified: assume they made money if they sold after buying
          earlyCalls++;
        }
      }
    }

    return {
      earlyCalls,
      // These need more data to calculate accurately
      winRate: undefined,
      avgEntryTiming: undefined,
    };
  }

  private calculateScores(
    stats: WalletProfile['stats'],
    performance: WalletProfile['performance'],
    knownInfo?: { name: string; type: WalletType },
  ): WalletProfile['score'] {
    // Smart money score: based on early calls and unique tokens
    let smartMoney = 0;
    smartMoney += Math.min(performance.earlyCalls * 10, 50);
    smartMoney += Math.min(stats.uniqueTokensTraded * 2, 30);
    if (knownInfo?.type === 'smart_money' || knownInfo?.type === 'influencer') {
      smartMoney += 20;
    }

    // Activity score: based on transaction count
    let activity = 0;
    if (stats.totalTxCount > 500) activity = 100;
    else if (stats.totalTxCount > 100) activity = 80;
    else if (stats.totalTxCount > 50) activity = 60;
    else if (stats.totalTxCount > 20) activity = 40;
    else activity = Math.min(stats.totalTxCount * 2, 20);

    // Influence score: based on known identity
    let influence = 20; // Base score
    if (knownInfo) {
      switch (knownInfo.type) {
        case 'influencer': influence = 90; break;
        case 'whale': influence = 70; break;
        case 'smart_money': influence = 80; break;
        case 'protocol': influence = 50; break;
        default: influence = 30;
      }
    }

    return {
      smartMoney: Math.min(smartMoney, 100),
      activity: Math.min(activity, 100),
      influence: Math.min(influence, 100),
    };
  }

  private generateTags(
    stats: WalletProfile['stats'],
    performance: WalletProfile['performance'],
    score: WalletProfile['score'],
    knownInfo?: { name: string; type: WalletType },
  ): WalletTag[] {
    const tags: WalletTag[] = [];

    if (score.smartMoney >= 60) tags.push('early_buyer');
    if (score.activity >= 80) tags.push('active');
    if (knownInfo) tags.push('verified');
    if (stats.totalTxCount < 10) tags.push('new_wallet');

    // Would need balance data for whale tag
    // Would need timing analysis for diamond_hands vs flipper

    return tags;
  }

  // ── Caching ──────────────────────────────────────────

  private async getCachedProfile(address: string): Promise<WalletProfile | null> {
    const key = this.PROFILE_PREFIX + address;
    const data = await this.memory.getCached(key);
    if (!data) return null;

    const profile = JSON.parse(data) as WalletProfile;

    // Invalidate if older than 1 hour
    if (Date.now() - profile.profiledAt > 3600000) {
      return null;
    }

    return profile;
  }

  private async cacheProfile(profile: WalletProfile): Promise<void> {
    const key = this.PROFILE_PREFIX + profile.address;
    await this.memory.setCache(key, JSON.stringify(profile));
  }
}
