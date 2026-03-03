import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RpcRequest,
  RpcResponse,
  WalletBalance,
  TokenBalance,
  TokenTransfer,
  TokenInfo,
  BlockWithTxs,
  AVAX_CONSTANTS,
} from '../interfaces/avax.types';

/**
 * AvaxRpcService
 *
 * Multi-source RPC client for Avalanche C-Chain.
 * Uses racing strategy: query all endpoints simultaneously, use first response.
 * Benchmarked endpoints from: https://gist.github.com/tactical-retreat/41a709edebe20e5d15639d35f963dfe2
 */
@Injectable()
export class AvaxRpcService implements OnModuleInit {
  private readonly logger = new Logger(AvaxRpcService.name);
  private requestId = 1;
  private cache = new Map<string, { data: unknown; expires: number }>();

  // Best AVAX C-Chain endpoints (ranked by uptime + speed)
  // Premium endpoints (with API keys) are added dynamically in onModuleInit
  private RACING_ENDPOINTS: Array<{ name: string; url: string }> = [
    { name: 'omniatech', url: 'https://endpoints.omniatech.io/v1/avax/mainnet/public' },   // 93.6% uptime
    { name: 'meowrpc', url: 'https://avax.meowrpc.com' },                                    // 91.9% uptime
    { name: 'drpc', url: 'https://avalanche.drpc.org' },                                     // 85.1% uptime, fastest
    { name: 'publicnode', url: 'https://avalanche-c-chain-rpc.publicnode.com' },             // 84.4% uptime
    { name: 'blastapi', url: 'https://ava-mainnet.public.blastapi.io/ext/bc/C/rpc' },       // 73.1% uptime, fast
  ];

  // Track endpoint performance for logging
  private endpointWins = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Add premium endpoints if API keys are configured (never log the keys!)
    const ankrKey = this.configService.get<string>('avax.ankrApiKey');
    if (ankrKey) {
      // Ankr premium - add to front of list (typically fastest with API key)
      this.RACING_ENDPOINTS.unshift({
        name: 'ankr',
        url: `https://rpc.ankr.com/avalanche/${ankrKey}`,
      });
      this.logger.log('Ankr premium endpoint enabled');
    }

    this.logger.log(`Initialized with ${this.RACING_ENDPOINTS.length} racing endpoints: ${this.RACING_ENDPOINTS.map(e => e.name).join(', ')}`);
  }

  // ── Core RPC Methods ─────────────────────────────────

  /**
   * Get native AVAX balance for an address
   */
  async getBalance(address: string): Promise<string> {
    const cacheKey = `balance:${address}`;
    const cached = this.getFromCache<string>(cacheKey);
    if (cached) return cached;

    const result = await this.rpcCall<string>('eth_getBalance', [address, 'latest']);
    this.setCache(cacheKey, result, 30); // Cache for 30 seconds
    return result;
  }

  /**
   * Get ERC20 token balance for an address
   */
  async getTokenBalance(address: string, tokenContract: string): Promise<string> {
    const cacheKey = `tokenBalance:${tokenContract}:${address}`;
    const cached = this.getFromCache<string>(cacheKey);
    if (cached) return cached;

    // Build calldata: balanceOf(address)
    const paddedAddress = address.toLowerCase().replace('0x', '').padStart(64, '0');
    const data = AVAX_CONSTANTS.SELECTORS.balanceOf + paddedAddress;

    const result = await this.rpcCall<string>('eth_call', [
      { to: tokenContract, data },
      'latest',
    ]);

    this.setCache(cacheKey, result, 30);
    return result;
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    const result = await this.rpcCall<string>('eth_blockNumber', []);
    return parseInt(result, 16);
  }

  /**
   * Get a block with full transaction details
   */
  async getBlockByNumber(blockNum: number): Promise<BlockWithTxs> {
    const blockHex = '0x' + blockNum.toString(16);
    return this.rpcCall<BlockWithTxs>('eth_getBlockByNumber', [blockHex, true]);
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash: string): Promise<{
    hash: string;
    from: string;
    to: string | null;
    value: string;
    blockNumber: string;
  } | null> {
    return this.rpcCall('eth_getTransactionByHash', [txHash]);
  }

  /**
   * Get token info (name, symbol, decimals)
   */
  async getTokenInfo(contractAddress: string): Promise<TokenInfo | null> {
    const cacheKey = `tokenInfo:${contractAddress}`;
    const cached = this.getFromCache<TokenInfo>(cacheKey);
    if (cached) return cached;

    try {
      const [nameHex, symbolHex, decimalsHex] = await Promise.all([
        this.rpcCall<string>('eth_call', [{ to: contractAddress, data: AVAX_CONSTANTS.SELECTORS.name }, 'latest']),
        this.rpcCall<string>('eth_call', [{ to: contractAddress, data: AVAX_CONSTANTS.SELECTORS.symbol }, 'latest']),
        this.rpcCall<string>('eth_call', [{ to: contractAddress, data: AVAX_CONSTANTS.SELECTORS.decimals }, 'latest']),
      ]);

      const info: TokenInfo = {
        contractAddress,
        name: this.decodeString(nameHex),
        symbol: this.decodeString(symbolHex),
        decimals: parseInt(decimalsHex, 16) || 18,
      };

      this.setCache(cacheKey, info, 3600); // Cache for 1 hour
      return info;
    } catch (error) {
      this.logger.warn(`Failed to get token info for ${contractAddress}: ${error}`);
      return null;
    }
  }

  /**
   * Get Transfer events for an address (incoming + outgoing)
   * Chunks requests to stay within RPC block limit (2048 max)
   */
  async getTransfers(address: string, fromBlock: number, toBlock: number | 'latest' = 'latest'): Promise<TokenTransfer[]> {
    const paddedAddress = '0x' + address.toLowerCase().replace('0x', '').padStart(64, '0');
    const MAX_BLOCK_RANGE = 2000; // Stay under 2048 limit

    // Resolve 'latest' to actual block number
    const endBlock = toBlock === 'latest' ? await this.getBlockNumber() : toBlock;

    type LogEntry = {
      transactionHash: string;
      blockNumber: string;
      address: string;
      topics: string[];
      data: string;
    };

    const allLogs: LogEntry[] = [];

    // Chunk the request into smaller ranges
    for (let start = fromBlock; start <= endBlock; start += MAX_BLOCK_RANGE) {
      const end = Math.min(start + MAX_BLOCK_RANGE - 1, endBlock);
      const fromBlockHex = '0x' + start.toString(16);
      const toBlockHex = '0x' + end.toString(16);

      try {
        // Get incoming transfers (to = address)
        const incomingLogs = await this.rpcCall<LogEntry[]>('eth_getLogs', [{
          fromBlock: fromBlockHex,
          toBlock: toBlockHex,
          topics: [AVAX_CONSTANTS.TOPICS.Transfer, null, paddedAddress],
        }]);

        // Get outgoing transfers (from = address)
        const outgoingLogs = await this.rpcCall<LogEntry[]>('eth_getLogs', [{
          fromBlock: fromBlockHex,
          toBlock: toBlockHex,
          topics: [AVAX_CONSTANTS.TOPICS.Transfer, paddedAddress],
        }]);

        allLogs.push(...incomingLogs, ...outgoingLogs);
      } catch (error) {
        this.logger.warn(`Failed to get transfers for blocks ${start}-${end}: ${error}`);
        // Continue with next chunk
      }
    }

    return allLogs.map(log => ({
      txHash: log.transactionHash,
      blockNumber: parseInt(log.blockNumber, 16),
      from: '0x' + log.topics[1].slice(26),
      to: '0x' + log.topics[2].slice(26),
      contractAddress: log.address,
      value: log.data,
    }));
  }

  /**
   * Get full wallet balance including tokens
   */
  async getWalletBalance(address: string, tokenContracts?: string[]): Promise<WalletBalance> {
    // Get native AVAX balance
    const avaxWei = await this.getBalance(address);
    const avaxFormatted = this.formatAvax(avaxWei);

    // If no specific tokens provided, use well-known ones
    const tokensToCheck = tokenContracts ?? Object.values(AVAX_CONSTANTS.TOKENS);

    // Get token balances in parallel
    const tokenBalances: TokenBalance[] = [];
    const results = await Promise.allSettled(
      tokensToCheck.map(async (contract) => {
        const balance = await this.getTokenBalance(address, contract);
        if (balance === '0x' || balance === '0x0' || BigInt(balance) === 0n) {
          return null;
        }
        const info = await this.getTokenInfo(contract);
        if (!info) return null;

        return {
          contractAddress: contract,
          symbol: info.symbol,
          name: info.name,
          decimals: info.decimals,
          balance,
          balanceFormatted: this.formatTokenBalance(balance, info.decimals),
        };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        tokenBalances.push(result.value);
      }
    }

    return {
      address,
      avax: avaxWei,
      avaxFormatted,
      tokens: tokenBalances,
    };
  }

  // ── Helper Methods ───────────────────────────────────

  /**
   * Race all endpoints simultaneously - first successful response wins.
   * This provides both speed AND reliability.
   */
  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const requestId = this.requestId++;
    const request: RpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s global timeout

    try {
      // Race all endpoints simultaneously
      const racePromises = this.RACING_ENDPOINTS.map(async (endpoint) => {
        const startTime = Date.now();
        try {
          const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data: RpcResponse<T> = await response.json();

          if (data.error) {
            throw new Error(`RPC Error: ${data.error.message}`);
          }

          const elapsed = Date.now() - startTime;
          return { result: data.result as T, endpoint: endpoint.name, elapsed };
        } catch (error) {
          // Rethrow to mark this promise as rejected
          throw { endpoint: endpoint.name, error };
        }
      });

      // Use Promise.any to get the first successful response
      const winner = await Promise.any(racePromises);

      // Track wins for logging
      const wins = (this.endpointWins.get(winner.endpoint) ?? 0) + 1;
      this.endpointWins.set(winner.endpoint, wins);

      // Log winner periodically (every 10th call)
      if (requestId % 10 === 0) {
        this.logger.debug(`RPC ${method} won by ${winner.endpoint} in ${winner.elapsed}ms (total wins: ${wins})`);
      }

      return winner.result;
    } catch (aggregateError) {
      // All promises rejected
      this.logger.error(`All ${this.RACING_ENDPOINTS.length} RPC endpoints failed for ${method}`);
      throw new Error(`All RPC endpoints failed for ${method}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Single endpoint call (used internally)
   */
  private async singleRpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const request: RpcRequest = {
      jsonrpc: '2.0',
      id: this.requestId++,
      method,
      params,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data: RpcResponse<T> = await response.json();

    if (data.error) {
      throw new Error(`RPC Error: ${data.error.message}`);
    }

    return data.result as T;
  }

  /**
   * Get endpoint statistics (for debugging)
   */
  getEndpointStats(): Record<string, number> {
    return Object.fromEntries(this.endpointWins);
  }

  private formatAvax(wei: string): string {
    const value = BigInt(wei);
    const avax = Number(value) / 1e18;
    return `${avax.toFixed(4)} AVAX`;
  }

  private formatTokenBalance(rawBalance: string, decimals: number): string {
    const value = BigInt(rawBalance);
    const divisor = BigInt(10 ** decimals);
    const whole = value / divisor;
    const fraction = value % divisor;
    const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 4);
    return `${whole}.${fractionStr}`;
  }

  private decodeString(hex: string): string {
    if (!hex || hex === '0x') return '';
    try {
      // ABI-encoded string: skip offset (32 bytes) and length (32 bytes)
      const data = hex.slice(2);
      if (data.length < 128) return '';

      const length = parseInt(data.slice(64, 128), 16);
      const strHex = data.slice(128, 128 + length * 2);

      let result = '';
      for (let i = 0; i < strHex.length; i += 2) {
        const charCode = parseInt(strHex.slice(i, i + 2), 16);
        if (charCode > 0) result += String.fromCharCode(charCode);
      }
      return result;
    } catch {
      return '';
    }
  }

  // ── Caching ──────────────────────────────────────────

  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCache(key: string, data: unknown, ttlSeconds: number): void {
    this.cache.set(key, {
      data,
      expires: Date.now() + ttlSeconds * 1000,
    });
  }
}
