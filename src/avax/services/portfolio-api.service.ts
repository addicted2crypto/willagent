import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Transfer from Snowtrace API
 */
export interface SnowtraceTransfer {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  // For native AVAX transactions
  isError?: string;
  functionName?: string;
}

/**
 * Normalized transfer for clustering
 */
export interface WalletTransfer {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  to: string;
  value: string;
  valueFormatted: string;
  type: 'native' | 'token';
  tokenContract?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
}

/**
 * Counterparty extracted from transfer history
 */
export interface Counterparty {
  address: string;
  sendCount: number;    // Times we sent TO them
  receiveCount: number; // Times we received FROM them
  totalInteractions: number;
  isBidirectional: boolean;
  lastInteraction: number;
  tokens: string[];     // Token contracts involved
}

/**
 * PortfolioApiService
 *
 * Uses Snowtrace API to get full wallet transfer history.
 * Much faster than raw RPC - one API call gets entire history.
 */
@Injectable()
export class PortfolioApiService {
  private readonly logger = new Logger(PortfolioApiService.name);
  private readonly SNOWTRACE_BASE = 'https://api.snowtrace.io/api';
  private readonly cache = new Map<string, { data: unknown; expires: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Get all native AVAX transactions for a wallet
   */
  async getNativeTransactions(address: string, taskId?: string): Promise<WalletTransfer[]> {
    const apiKey = this.config.get<string>('avax.snowtraceKey') || '';
    const url = `${this.SNOWTRACE_BASE}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

    this.emitProgress(taskId, 'Fetching native AVAX transactions...', 10);

    const data = await this.fetchWithCache<SnowtraceTransfer[]>(url, `native:${address}`);
    if (!data) return [];

    return data.map(tx => ({
      txHash: tx.hash,
      blockNumber: parseInt(tx.blockNumber, 10),
      timestamp: parseInt(tx.timeStamp, 10) * 1000,
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      value: tx.value,
      valueFormatted: this.formatAvax(tx.value),
      type: 'native' as const,
    }));
  }

  /**
   * Get all ERC20 token transfers for a wallet
   */
  async getTokenTransfers(address: string, taskId?: string): Promise<WalletTransfer[]> {
    const apiKey = this.config.get<string>('avax.snowtraceKey') || '';
    const url = `${this.SNOWTRACE_BASE}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

    this.emitProgress(taskId, 'Fetching token transfers...', 25);

    const data = await this.fetchWithCache<SnowtraceTransfer[]>(url, `tokens:${address}`);
    if (!data) return [];

    return data.map(tx => ({
      txHash: tx.hash,
      blockNumber: parseInt(tx.blockNumber, 10),
      timestamp: parseInt(tx.timeStamp, 10) * 1000,
      from: tx.from.toLowerCase(),
      to: tx.to.toLowerCase(),
      value: tx.value,
      valueFormatted: this.formatToken(tx.value, parseInt(tx.tokenDecimal || '18', 10)),
      type: 'token' as const,
      tokenContract: tx.contractAddress?.toLowerCase(),
      tokenSymbol: tx.tokenSymbol,
      tokenDecimals: parseInt(tx.tokenDecimal || '18', 10),
    }));
  }

  /**
   * Get ALL transfers for a wallet (native + tokens)
   * This is the key method for clustering - one call gets everything!
   */
  async getAllTransfers(address: string, taskId?: string): Promise<WalletTransfer[]> {
    const normalized = address.toLowerCase();

    this.emitProgress(taskId, `Fetching full transfer history for ${normalized.slice(0, 10)}...`, 5);

    const [native, tokens] = await Promise.all([
      this.getNativeTransactions(normalized, taskId),
      this.getTokenTransfers(normalized, taskId),
    ]);

    this.emitProgress(taskId, `Found ${native.length} native + ${tokens.length} token transfers`, 40);

    // Combine and sort by timestamp (newest first)
    const all = [...native, ...tokens].sort((a, b) => b.timestamp - a.timestamp);

    this.logger.log(`Fetched ${all.length} total transfers for ${normalized.slice(0, 10)}...`);
    return all;
  }

  /**
   * Extract counterparties from transfer history
   * These are wallets that interacted directly with our target
   */
  extractCounterparties(address: string, transfers: WalletTransfer[]): Counterparty[] {
    const normalized = address.toLowerCase();
    const counterpartyMap = new Map<string, Counterparty>();

    for (const tx of transfers) {
      // Determine if we sent or received
      const isSender = tx.from === normalized;
      const counterpartyAddr = isSender ? tx.to : tx.from;

      // Skip self-transfers and null addresses
      if (counterpartyAddr === normalized) continue;
      if (counterpartyAddr === '0x0000000000000000000000000000000000000000') continue;

      // Get or create counterparty record
      let cp = counterpartyMap.get(counterpartyAddr);
      if (!cp) {
        cp = {
          address: counterpartyAddr,
          sendCount: 0,
          receiveCount: 0,
          totalInteractions: 0,
          isBidirectional: false,
          lastInteraction: 0,
          tokens: [],
        };
        counterpartyMap.set(counterpartyAddr, cp);
      }

      // Update counts
      if (isSender) {
        cp.sendCount++;
      } else {
        cp.receiveCount++;
      }
      cp.totalInteractions++;

      // Track latest interaction
      if (tx.timestamp > cp.lastInteraction) {
        cp.lastInteraction = tx.timestamp;
      }

      // Track tokens involved
      if (tx.tokenContract && !cp.tokens.includes(tx.tokenContract)) {
        cp.tokens.push(tx.tokenContract);
      }
    }

    // Mark bidirectional relationships
    for (const cp of counterpartyMap.values()) {
      cp.isBidirectional = cp.sendCount > 0 && cp.receiveCount > 0;
    }

    // Sort by total interactions (most active first)
    return Array.from(counterpartyMap.values())
      .sort((a, b) => b.totalInteractions - a.totalInteractions);
  }

  /**
   * Find direct transfers between two specific wallets
   */
  findDirectTransfers(transfers: WalletTransfer[], wallet1: string, wallet2: string): WalletTransfer[] {
    const w1 = wallet1.toLowerCase();
    const w2 = wallet2.toLowerCase();

    return transfers.filter(tx =>
      (tx.from === w1 && tx.to === w2) ||
      (tx.from === w2 && tx.to === w1)
    );
  }

  // ── Helper Methods ──────────────────────────────────────

  private async fetchWithCache<T>(url: string, cacheKey: string): Promise<T | null> {
    // Check cache (5 minute TTL)
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.data as T;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.logger.warn(`Snowtrace API error: ${response.status}`);
        return null;
      }

      const json = await response.json();
      if (json.status !== '1' || !json.result) {
        // Status 0 with "No transactions found" is not an error
        if (json.message === 'No transactions found') {
          return [] as T;
        }
        this.logger.warn(`Snowtrace API: ${json.message}`);
        return null;
      }

      // Cache the result
      this.cache.set(cacheKey, {
        data: json.result,
        expires: Date.now() + 5 * 60 * 1000, // 5 minutes
      });

      return json.result as T;
    } catch (error) {
      this.logger.error(`Snowtrace fetch failed: ${error}`);
      return null;
    }
  }

  private formatAvax(wei: string): string {
    if (!wei || wei === '0') return '0 AVAX';
    const value = BigInt(wei);
    const avax = Number(value) / 1e18;
    return `${avax.toFixed(4)} AVAX`;
  }

  private formatToken(rawBalance: string, decimals: number): string {
    if (!rawBalance || rawBalance === '0') return '0';
    const value = BigInt(rawBalance);
    const divisor = BigInt(10 ** decimals);
    const whole = value / divisor;
    const fraction = value % divisor;
    const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 4);
    return `${whole}.${fractionStr}`;
  }

  private emitProgress(taskId: string | undefined, message: string, progress: number): void {
    if (taskId) {
      this.eventEmitter.emit('task.progress', {
        taskId,
        step: 'portfolio',
        message,
        progress,
      });
    }
    this.logger.debug(message);
  }

  // ── DeBank Full Portfolio API ──────────────────────────────

  /**
   * Get full portfolio value from DeBank including DeFi positions
   * This shows the REAL total value, not just wallet tokens
   */
  async getDebankPortfolio(address: string): Promise<{
    totalUsd: number;
    chains: Array<{ chain: string; usd: number }>;
    protocols: Array<{ name: string; usd: number; chain: string }>;
    topTokens: Array<{ symbol: string; amount: number; usd: number; chain: string }>;
  }> {
    const result = {
      totalUsd: 0,
      chains: [] as Array<{ chain: string; usd: number }>,
      protocols: [] as Array<{ name: string; usd: number; chain: string }>,
      topTokens: [] as Array<{ symbol: string; amount: number; usd: number; chain: string }>,
    };

    try {
      // Get total balance across all chains
      const totalResponse = await fetch(
        `https://api.debank.com/user/total_balance?addr=${address}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (totalResponse.ok) {
        const totalData = await totalResponse.json();
        if (totalData.data?.total_usd_value !== undefined) {
          result.totalUsd = totalData.data.total_usd_value;
        }
        // Chain breakdown
        if (totalData.data?.chain_list) {
          result.chains = totalData.data.chain_list
            .filter((c: { usd_value: number }) => c.usd_value > 0)
            .map((c: { id: string; usd_value: number }) => ({
              chain: c.id,
              usd: c.usd_value,
            }))
            .sort((a: { usd: number }, b: { usd: number }) => b.usd - a.usd);
        }
      }

      // Get DeFi protocol positions (this is where most value often is!)
      const protocolResponse = await fetch(
        `https://api.debank.com/portfolio/project_list?user_addr=${address}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (protocolResponse.ok) {
        const protocolData = await protocolResponse.json();
        if (protocolData.data) {
          result.protocols = protocolData.data
            .filter((p: { portfolio_item_list?: unknown[] }) => p.portfolio_item_list?.length)
            .map((p: { name: string; chain: string; portfolio_item_list: Array<{ stats: { net_usd_value: number } }> }) => ({
              name: p.name,
              chain: p.chain,
              usd: p.portfolio_item_list.reduce(
                (sum: number, item: { stats: { net_usd_value: number } }) => sum + (item.stats?.net_usd_value || 0),
                0
              ),
            }))
            .filter((p: { usd: number }) => p.usd > 0)
            .sort((a: { usd: number }, b: { usd: number }) => b.usd - a.usd);
        }
      }

      // Get top tokens with values
      const tokenResponse = await fetch(
        `https://api.debank.com/user/token_list?id=${address}&is_all=true`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (tokenResponse.ok) {
        const tokenData = await tokenResponse.json();
        if (tokenData.data) {
          result.topTokens = tokenData.data
            .filter((t: { price: number; amount: number }) => t.price > 0 && t.amount > 0)
            .map((t: { symbol: string; amount: number; price: number; chain: string }) => ({
              symbol: t.symbol,
              amount: t.amount,
              usd: t.amount * t.price,
              chain: t.chain,
            }))
            .sort((a: { usd: number }, b: { usd: number }) => b.usd - a.usd)
            .slice(0, 10);
        }
      }

    } catch (error) {
      this.logger.warn(`DeBank portfolio fetch failed: ${error}`);
    }

    return result;
  }

  /**
   * Format DeBank portfolio for display
   */
  formatDebankPortfolio(portfolio: Awaited<ReturnType<typeof this.getDebankPortfolio>>): string {
    const lines: string[] = [];

    lines.push(`TOTAL VALUE: $${portfolio.totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    lines.push('');

    if (portfolio.protocols.length > 0) {
      lines.push('DEFI POSITIONS:');
      for (const p of portfolio.protocols.slice(0, 5)) {
        lines.push(`  ${p.name} (${p.chain}): $${p.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
      }
      lines.push('');
    }

    if (portfolio.topTokens.length > 0) {
      lines.push('TOP TOKENS:');
      for (const t of portfolio.topTokens.slice(0, 5)) {
        lines.push(`  ${t.symbol}: ${t.amount.toFixed(4)} ($${t.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
      }
    }

    if (portfolio.chains.length > 1) {
      lines.push('');
      lines.push('BY CHAIN:');
      for (const c of portfolio.chains.slice(0, 5)) {
        lines.push(`  ${c.chain}: $${c.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
      }
    }

    return lines.join('\n');
  }
}
