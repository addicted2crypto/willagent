import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryService } from '../../memory/memory.service';
import { AvaxRpcService } from './avax-rpc.service';
import { PortfolioApiService, Counterparty, WalletTransfer } from './portfolio-api.service';
import {
  WalletCluster,
  WalletClusterData,
  ClusterConnection,
  ClusterMember,
  TokenTransfer,
} from '../interfaces/avax.types';

/**
 * WalletClusterService
 *
 * Finds wallets likely owned by the same person by analyzing:
 * - Transfer history (who they send to / receive from)
 * - Bidirectional transfers (strong signal!)
 * - Token overlap (what they hold)
 * - Funding source (who sent first AVAX)
 *
 * Now uses Snowtrace API for full transfer history (much faster than RPC!)
 */
@Injectable()
export class WalletClusterService {
  private readonly logger = new Logger(WalletClusterService.name);
  private readonly CLUSTER_PREFIX = 'avax:cluster:';
  private readonly SNOWTRACE_BASE = 'https://snowtrace.io';
  private readonly DEBANK_BASE = 'https://debank.com/profile';
  private readonly METASLEUTH_BASE = 'https://metasleuth.io/result/avax';

  // Known entities to exclude from clustering (exchanges, protocols, routers, tokens)
  // These are contracts/services, not user wallets
  private readonly EXCLUDED_ENTITIES = new Set([
    // Exchanges
    '0x9f8c163cba728e99993abe7495f06c0a3c8ac8b9', // Binance
    '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', // Binance Cold
    '0x28c6c06298d514db089934071355e5743bf21d60', // Binance Hot
    '0x21a31ee1afc51d94c2efccaa2092ad1028285549', // Bybit
    '0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23', // Coinbase
    '0xa910f92acdaf488fa6ef02174fb86208ad7722ba', // OKX

    // DEX Routers
    '0x60ae616a2155ee3d9a68541ba4544862310933d4', // TraderJoe Router
    '0x9aab3f75489902f3a48495025729a0af77d4b11e', // Pangolin Router
    '0xdef171fe48cf0115b1d80b88dc8eab59176fee57', // ParaSwap
    '0xe54ca86531e17ef3616d22ca28b0d458b6c89106', // Pangolin
    '0xe0e4d6ec96f11fc1cdde1e7a3146a16ed8d5c8c8', // Trader Joe

    // Token Contracts (NOT wallets - filter these out!)
    '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', // WAVAX
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', // USDt
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // USDC
    '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab', // WETH.e
    '0x50b7545627a5162f82a992c33b87adc75187b218', // WBTC.e
    '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be', // sAVAX
    '0x5947bb275c521040051d82396192181b413227a3', // LINK.e
    '0xd586e7f844cea2f87f50152665bcbc2c279d8d70', // DAI.e
    '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664', // USDC.e
    '0xc7198437980c041c805a1edcba50c1ce5db95118', // USDT.e
    '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd', // JOE token

    // Bridges
    '0x8eb8a3b98659cce290402893d0123abb75e3ab28', // Avalanche Bridge

    // Special addresses
    '0x0000000000000000000000000000000000000000', // Null address
    '0x000000000000000000000000000000000000dead', // Burn address
  ]);

  constructor(
    private readonly memory: MemoryService,
    private readonly rpc: AvaxRpcService,
    private readonly portfolio: PortfolioApiService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Main Clustering Methods ─────────────────────────────

  /**
   * Start a new cluster from a seed wallet
   */
  async startCluster(
    seedAddress: string,
    tag: string,
    options?: { minScore?: number; blocksBack?: number },
  ): Promise<WalletCluster> {
    const normalized = seedAddress.toLowerCase();
    const minScore = options?.minScore ?? 50;
    const blocksBack = options?.blocksBack ?? 10000; // ~1-2 days (faster initial scan)

    this.logger.log(`Starting cluster for ${tag} (${normalized})`);

    // Collect data for seed wallet
    const seedData = await this.collectWalletData(normalized, blocksBack);

    if (!seedData.firstFunder) {
      this.logger.warn(`No funding source found for ${normalized}`);
    }

    // Find related wallets
    const candidates: Array<{ address: string; connection: ClusterConnection }> = [];

    // Method 1: Find wallets with same first funder
    if (seedData.firstFunder && !this.isExcluded(seedData.firstFunder)) {
      const siblings = await this.findSameFunderWallets(seedData.firstFunder, blocksBack);
      for (const sibling of siblings) {
        if (sibling.toLowerCase() === normalized) continue;
        if (this.isExcluded(sibling)) continue;

        const connection = await this.scoreConnection(normalized, sibling, seedData);
        if (connection.totalScore >= minScore) {
          candidates.push({ address: sibling, connection });
        }
      }
    }

    // Method 2: Find wallets with common recipients (if we have recipients)
    if (seedData.recipients.length > 0) {
      const recipientOverlap = await this.findCommonRecipientWallets(normalized, seedData.recipients, blocksBack);
      for (const [wallet, overlapCount] of recipientOverlap) {
        if (wallet.toLowerCase() === normalized) continue;
        if (this.isExcluded(wallet)) continue;
        if (candidates.some(c => c.address.toLowerCase() === wallet.toLowerCase())) continue;

        const connection = await this.scoreConnection(normalized, wallet, seedData);
        if (connection.totalScore >= minScore) {
          candidates.push({ address: wallet, connection });
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.connection.totalScore - a.connection.totalScore);

    // Create cluster
    const cluster: WalletCluster = {
      id: `clust_${uuid().slice(0, 8)}`,
      seedWallet: normalized,
      seedTag: tag,
      members: candidates.slice(0, 20).map(c => ({
        address: c.address,
        connection: c.connection,
        addedAt: Date.now(),
        verified: false,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastScannedBlock: await this.rpc.getBlockNumber(),
    };

    // Save cluster
    await this.saveCluster(cluster);

    this.logger.log(`Cluster ${cluster.id} created with ${cluster.members.length} members`);
    return cluster;
  }

  /**
   * Get a cluster by ID
   */
  async getCluster(clusterId: string): Promise<WalletCluster | null> {
    const data = await this.memory.getCached(this.CLUSTER_PREFIX + clusterId);
    if (!data) return null;
    return JSON.parse(data) as WalletCluster;
  }

  /**
   * List all clusters
   */
  async listClusters(): Promise<string[]> {
    const listData = await this.memory.getCached(this.CLUSTER_PREFIX + 'list');
    if (!listData) return [];
    return JSON.parse(listData) as string[];
  }

  /**
   * Mark a cluster member as verified
   */
  async verifyMember(
    clusterId: string,
    memberAddress: string,
    notes?: string,
  ): Promise<boolean> {
    const cluster = await this.getCluster(clusterId);
    if (!cluster) return false;

    const member = cluster.members.find(
      m => m.address.toLowerCase() === memberAddress.toLowerCase(),
    );
    if (!member) return false;

    member.verified = true;
    member.verificationNotes = notes;
    cluster.updatedAt = Date.now();

    await this.saveCluster(cluster);
    this.logger.log(`Verified member ${memberAddress.slice(0, 10)}... in cluster ${clusterId}`);
    return true;
  }

  // ── Smart Clustering (Transfer History Based) ──────────────

  /**
   * Smart cluster using Snowtrace transfer history
   * Much faster than RPC - gets full history in one API call!
   */
  async smartCluster(
    seedAddress: string,
    tag: string,
    options?: { minScore?: number; taskId?: string; deep?: boolean },
  ): Promise<WalletCluster> {
    const normalized = seedAddress.toLowerCase();
    const minScore = options?.minScore ?? 40;
    const taskId = options?.taskId;
    const deepMode = options?.deep ?? false;

    this.logger.log(`Smart clustering for ${tag} (${normalized}) [deep=${deepMode}]`);
    this.emitProgress(taskId, `Starting ${deepMode ? 'DEEP' : 'smart'} cluster for ${tag}...`, 0);

    // 1. Get full transfer history via Snowtrace (one API call!)
    const transfers = await this.portfolio.getAllTransfers(normalized, taskId);
    this.emitProgress(taskId, `Analyzing ${transfers.length} transfers...`, 20);

    if (transfers.length === 0) {
      this.logger.warn(`No transfers found for ${normalized}`);
    }

    // 2. Extract counterparties (wallets that interacted with seed)
    const counterparties = this.portfolio.extractCounterparties(normalized, transfers);
    const counterpartyLimit = deepMode ? counterparties.length : Math.min(50, counterparties.length);
    this.logger.log(`Found ${counterparties.length} unique counterparties, analyzing ${counterpartyLimit}`);
    this.emitProgress(taskId, `Found ${counterparties.length} counterparties, analyzing ${counterpartyLimit}...`, 25);

    // 3. Score and filter candidates WITH per-wallet progress
    const candidates: Array<{ address: string; connection: ClusterConnection }> = [];
    const toAnalyze = counterparties.slice(0, counterpartyLimit);

    for (let i = 0; i < toAnalyze.length; i++) {
      const cp = toAnalyze[i];
      if (this.isExcluded(cp.address)) continue;

      // Show progress for each wallet being scored
      const shortAddr = `${cp.address.slice(0, 6)}...${cp.address.slice(-4)}`;
      const progressPercent = 25 + Math.floor((i / toAnalyze.length) * 50);

      // Show bidirectional status in progress
      const bidirFlag = cp.isBidirectional ? ' <-> BIDIRECTIONAL' : '';
      const interactionInfo = `${cp.totalInteractions} txns`;
      this.emitProgress(taskId, `[${i + 1}/${toAnalyze.length}] Scoring ${shortAddr} (${interactionInfo})${bidirFlag}`, progressPercent);

      const connection = this.scoreCounterparty(normalized, cp, transfers);
      if (connection.totalScore >= minScore) {
        candidates.push({ address: cp.address, connection });
        // Emit when we find a high-scoring wallet
        if (connection.totalScore >= 60) {
          this.emitProgress(taskId, `MATCH: ${shortAddr} SCORE=${connection.totalScore} [${connection.confidence.toUpperCase()}]`, progressPercent);
        }
      }
    }

    // Sort by score
    candidates.sort((a, b) => b.connection.totalScore - a.connection.totalScore);
    this.emitProgress(taskId, `Found ${candidates.length} related wallets above threshold`, 75);

    // 4. Optional: Deep mode - check 2nd-degree connections
    let secondDegree: Array<{ address: string; connection: ClusterConnection }> = [];
    if (deepMode && candidates.length > 0) {
      this.emitProgress(taskId, `DEEP MODE: Checking 2nd-degree connections...`, 76);
      secondDegree = await this.analyze2ndDegreeConnections(
        normalized,
        candidates.slice(0, 5), // Top 5 candidates
        minScore,
        taskId,
      );
      this.emitProgress(taskId, `Found ${secondDegree.length} 2nd-degree wallets`, 90);
    }

    // Merge candidates (dedupe by address)
    const allCandidates = [...candidates];
    for (const sd of secondDegree) {
      if (!allCandidates.some(c => c.address === sd.address)) {
        allCandidates.push(sd);
      }
    }
    allCandidates.sort((a, b) => b.connection.totalScore - a.connection.totalScore);

    // 5. Create cluster
    const cluster: WalletCluster = {
      id: `clust_${uuid().slice(0, 8)}`,
      seedWallet: normalized,
      seedTag: tag,
      members: allCandidates.slice(0, 30).map(c => ({ // Allow more members in deep mode
        address: c.address,
        connection: c.connection,
        addedAt: Date.now(),
        verified: false,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastScannedBlock: await this.rpc.getBlockNumber(),
    };

    await this.saveCluster(cluster);
    this.emitProgress(taskId, `Cluster ${cluster.id} created with ${cluster.members.length} members`, 100);
    this.logger.log(`Smart cluster ${cluster.id} created with ${cluster.members.length} members`);

    return cluster;
  }

  /**
   * Analyze 2nd-degree connections (wallets connected to our top candidates)
   * This finds wallets that are connected to wallets we already identified
   */
  private async analyze2ndDegreeConnections(
    seedAddress: string,
    topCandidates: Array<{ address: string; connection: ClusterConnection }>,
    minScore: number,
    taskId?: string,
  ): Promise<Array<{ address: string; connection: ClusterConnection }>> {
    const secondDegree: Array<{ address: string; connection: ClusterConnection }> = [];
    const alreadyKnown = new Set([seedAddress, ...topCandidates.map(c => c.address)]);

    for (let i = 0; i < topCandidates.length; i++) {
      const candidate = topCandidates[i];
      const shortAddr = `${candidate.address.slice(0, 6)}...${candidate.address.slice(-4)}`;

      this.emitProgress(taskId, `2nd-degree: Fetching transfers for ${shortAddr}...`, 77 + (i * 2));

      // Get transfers for this candidate
      const transfers = await this.portfolio.getAllTransfers(candidate.address, undefined);
      const counterparties = this.portfolio.extractCounterparties(candidate.address, transfers);

      // Look for bidirectional relationships or strong connections
      const strong = counterparties.filter(cp =>
        cp.isBidirectional &&
        !alreadyKnown.has(cp.address) &&
        !this.isExcluded(cp.address)
      );

      for (const cp of strong.slice(0, 5)) {
        const cpShort = `${cp.address.slice(0, 6)}...${cp.address.slice(-4)}`;
        this.emitProgress(taskId, `2nd-degree: ${cpShort} <-> ${shortAddr}`, 78 + (i * 2));

        // Score this 2nd-degree wallet relative to the seed
        const seedTransfers = await this.portfolio.getAllTransfers(seedAddress, undefined);
        const connection = this.scoreCounterparty(seedAddress, cp, seedTransfers);

        // Lower threshold for 2nd-degree (they're connected through intermediary)
        if (connection.totalScore >= minScore * 0.7) {
          connection.evidence.push({
            type: 'recipient',
            description: `Connected via ${shortAddr} (2nd-degree)`,
            url: this.debankUrl(candidate.address),
          });
          secondDegree.push({ address: cp.address, connection });
          alreadyKnown.add(cp.address);
        }
      }
    }

    return secondDegree;
  }

  /**
   * Score a counterparty based on transfer patterns
   */
  private scoreCounterparty(
    seedAddress: string,
    cp: Counterparty,
    transfers: WalletTransfer[],
  ): ClusterConnection {
    const scores = {
      sameFunder: 0,
      recipientOverlap: 0, // We use this for bidirectional
      tokenOverlap: 0,
    };
    const evidence: ClusterConnection['evidence'] = [];

    // STRONG signal: Bidirectional transfers (A→B AND B→A)
    if (cp.isBidirectional) {
      scores.recipientOverlap = 90; // Very high score
      evidence.push({
        type: 'recipient',
        description: `BIDIRECTIONAL: ${cp.sendCount} sent, ${cp.receiveCount} received`,
        url: this.debankUrl(cp.address),
      });
    } else if (cp.totalInteractions >= 3) {
      // Multiple one-way transfers still indicate relationship
      scores.recipientOverlap = Math.min(cp.totalInteractions * 10, 50);
      evidence.push({
        type: 'recipient',
        description: `${cp.totalInteractions} interactions (${cp.sendCount} out, ${cp.receiveCount} in)`,
        url: this.snowtraceUrl('address', cp.address),
      });
    }

    // Token overlap bonus
    if (cp.tokens.length > 0) {
      scores.tokenOverlap = Math.min(cp.tokens.length * 15, 50);
      evidence.push({
        type: 'token',
        description: `${cp.tokens.length} shared tokens`,
        url: this.snowtraceUrl('address', cp.address),
      });
    }

    // Find example transaction for evidence
    const directTx = transfers.find(tx =>
      (tx.from === seedAddress && tx.to === cp.address) ||
      (tx.from === cp.address && tx.to === seedAddress)
    );
    if (directTx) {
      evidence.push({
        type: 'funding',
        description: `Direct transfer: ${directTx.valueFormatted}`,
        txHash: directTx.txHash,
        url: this.snowtraceUrl('tx', directTx.txHash),
      });
    }

    // Calculate total (weighted)
    const totalScore = Math.round(
      scores.sameFunder * 0.3 +
      scores.recipientOverlap * 0.5 + // Bidirectional is most important
      scores.tokenOverlap * 0.2
    );

    const confidence: ClusterConnection['confidence'] =
      totalScore >= 70 ? 'high' :
      totalScore >= 45 ? 'medium' : 'low';

    return {
      wallet: cp.address,
      seedWallet: seedAddress,
      scores,
      totalScore,
      confidence,
      evidence,
    };
  }

  private emitProgress(taskId: string | undefined, message: string, progress: number): void {
    if (taskId) {
      this.eventEmitter.emit('task.progress', {
        taskId,
        step: 'clustering',
        message,
        progress,
      });
    }
  }

  // ── Data Collection ─────────────────────────────────────

  /**
   * Collect clustering data for a wallet
   */
  async collectWalletData(address: string, blocksBack: number): Promise<WalletClusterData> {
    const normalized = address.toLowerCase();
    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - blocksBack);

    // Get transfers
    const transfers = await this.rpc.getTransfers(normalized, fromBlock);

    // Find first funder from native AVAX transactions
    const funding = await this.getFirstFunder(normalized, fromBlock, currentBlock);

    // Analyze recipients (outgoing transfers)
    const recipientMap = new Map<string, number>();
    for (const t of transfers) {
      if (t.from.toLowerCase() === normalized) {
        const to = t.to.toLowerCase();
        recipientMap.set(to, (recipientMap.get(to) ?? 0) + 1);
      }
    }

    const recipients = Array.from(recipientMap.entries())
      .map(([addr, count]) => ({ address: addr, txCount: count }))
      .sort((a, b) => b.txCount - a.txCount)
      .slice(0, 50); // Top 50 recipients

    // Get unique tokens held
    const tokenContracts = [...new Set(transfers.map(t => t.contractAddress))];
    const tokens: string[] = [];
    for (const contract of tokenContracts.slice(0, 20)) {
      try {
        const balance = await this.rpc.getTokenBalance(normalized, contract);
        if (BigInt(balance) > 0n) {
          tokens.push(contract.toLowerCase());
        }
      } catch {
        // Skip tokens that fail
      }
    }

    return {
      address: normalized,
      firstFunder: funding?.address ?? null,
      firstFundingTxHash: funding?.txHash ?? null,
      firstFundingBlock: funding?.block ?? null,
      recipients,
      tokens,
      collectedAt: Date.now(),
    };
  }

  /**
   * Find the first address that sent AVAX to this wallet
   */
  async getFirstFunder(
    address: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<{ address: string; txHash: string; block: number } | null> {
    const normalized = address.toLowerCase();

    // Binary search for first activity
    const firstBlock = await this.binarySearchFirstActivity(normalized, fromBlock, toBlock);
    if (!firstBlock) return null;

    // Get block with full transactions
    const block = await this.rpc.getBlockByNumber(firstBlock);
    if (!block?.transactions) return null;

    // Find first tx where to === address
    for (const tx of block.transactions) {
      if (tx.to?.toLowerCase() === normalized) {
        return {
          address: tx.from.toLowerCase(),
          txHash: tx.hash,
          block: firstBlock,
        };
      }
    }

    return null;
  }

  /**
   * Find wallets funded by the same source
   */
  async findSameFunderWallets(funderAddress: string, blocksBack: number): Promise<string[]> {
    const normalized = funderAddress.toLowerCase();
    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - blocksBack);

    // Get outgoing transfers from funder
    const transfers = await this.rpc.getTransfers(normalized, fromBlock);
    const outgoing = transfers.filter(t => t.from.toLowerCase() === normalized);

    // Unique recipients
    const recipients = [...new Set(outgoing.map(t => t.to.toLowerCase()))];

    this.logger.debug(`Found ${recipients.length} wallets funded by ${normalized.slice(0, 10)}...`);
    return recipients;
  }

  /**
   * Find wallets that send to the same recipients
   */
  async findCommonRecipientWallets(
    address: string,
    seedRecipients: Array<{ address: string; txCount: number }>,
    blocksBack: number,
  ): Promise<Map<string, number>> {
    const overlapMap = new Map<string, number>();
    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - blocksBack);

    // For each of the seed's top recipients, find who else sends to them
    for (const recipient of seedRecipients.slice(0, 10)) {
      try {
        const recipientTransfers = await this.rpc.getTransfers(recipient.address, fromBlock);
        const senders = recipientTransfers
          .filter(t => t.to.toLowerCase() === recipient.address.toLowerCase())
          .map(t => t.from.toLowerCase());

        for (const sender of senders) {
          if (sender !== address.toLowerCase()) {
            overlapMap.set(sender, (overlapMap.get(sender) ?? 0) + 1);
          }
        }
      } catch {
        // Skip on error
      }
    }

    return overlapMap;
  }

  // ── Scoring ─────────────────────────────────────────────

  /**
   * Check for bidirectional transfers (strong evidence of same owner)
   */
  async hasBidirectionalTransfers(
    wallet1: string,
    wallet2: string,
    blocksBack: number,
  ): Promise<{ hasBidirectional: boolean; transfers: Array<{ from: string; to: string; txHash: string }> }> {
    const w1 = wallet1.toLowerCase();
    const w2 = wallet2.toLowerCase();
    const currentBlock = await this.rpc.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - blocksBack);

    const transfers1 = await this.rpc.getTransfers(w1, fromBlock);
    const transfers2 = await this.rpc.getTransfers(w2, fromBlock);

    // Check for transfers from w1 to w2
    const w1ToW2 = transfers1.filter(
      t => t.from.toLowerCase() === w1 && t.to.toLowerCase() === w2
    );

    // Check for transfers from w2 to w1
    const w2ToW1 = transfers2.filter(
      t => t.from.toLowerCase() === w2 && t.to.toLowerCase() === w1
    );

    const bidirectional = w1ToW2.length > 0 && w2ToW1.length > 0;

    return {
      hasBidirectional: bidirectional,
      transfers: [
        ...w1ToW2.map(t => ({ from: w1, to: w2, txHash: t.txHash })),
        ...w2ToW1.map(t => ({ from: w2, to: w1, txHash: t.txHash })),
      ],
    };
  }

  /**
   * Score the connection between two wallets
   */
  async scoreConnection(
    seedAddress: string,
    candidateAddress: string,
    seedData: WalletClusterData,
  ): Promise<ClusterConnection> {
    const candidate = candidateAddress.toLowerCase();
    const seed = seedAddress.toLowerCase();
    const blocksBack = 100000;

    // Collect candidate data
    const candidateData = await this.collectWalletData(candidate, blocksBack);

    const scores = {
      sameFunder: 0,
      recipientOverlap: 0,
      tokenOverlap: 0,
    };

    const evidence: ClusterConnection['evidence'] = [];

    // Check for bidirectional transfers (STRONG signal)
    const bidirectional = await this.hasBidirectionalTransfers(seed, candidate, blocksBack);
    if (bidirectional.hasBidirectional) {
      // Bidirectional transfers are very strong evidence
      scores.recipientOverlap = 90; // Boost recipient overlap score
      evidence.push({
        type: 'recipient',
        description: `BIDIRECTIONAL: ${bidirectional.transfers.length} transfers between wallets`,
        txHash: bidirectional.transfers[0]?.txHash,
        url: this.snowtraceUrl('tx', bidirectional.transfers[0]?.txHash ?? ''),
      });
    }

    // Score: Same first funder
    if (seedData.firstFunder && candidateData.firstFunder) {
      if (seedData.firstFunder === candidateData.firstFunder) {
        scores.sameFunder = 80;
        evidence.push({
          type: 'funding',
          description: `Both funded by ${seedData.firstFunder.slice(0, 10)}...`,
          txHash: candidateData.firstFundingTxHash ?? undefined,
          url: this.snowtraceUrl('address', seedData.firstFunder),
        });

        // Bonus if funded close together in time
        if (seedData.firstFundingBlock && candidateData.firstFundingBlock) {
          const blockDiff = Math.abs(seedData.firstFundingBlock - candidateData.firstFundingBlock);
          if (blockDiff < 100) scores.sameFunder = 100; // Same day
          else if (blockDiff < 1000) scores.sameFunder = 90;
        }
      }
    }

    // Score: Recipient overlap
    const seedRecipients = new Set(seedData.recipients.map(r => r.address));
    const candidateRecipients = new Set(candidateData.recipients.map(r => r.address));
    const commonRecipients = [...seedRecipients].filter(r => candidateRecipients.has(r));

    if (commonRecipients.length > 0) {
      scores.recipientOverlap = Math.min(commonRecipients.length * 15, 80);
      evidence.push({
        type: 'recipient',
        description: `${commonRecipients.length} common recipients`,
        url: this.snowtraceUrl('address', commonRecipients[0]),
      });
    }

    // Score: Token overlap (only rare tokens)
    const seedTokens = new Set(seedData.tokens);
    const candidateTokens = new Set(candidateData.tokens);
    const commonTokens = [...seedTokens].filter(t => candidateTokens.has(t));

    if (commonTokens.length > 0) {
      scores.tokenOverlap = Math.min(commonTokens.length * 10, 50);
      evidence.push({
        type: 'token',
        description: `${commonTokens.length} common tokens`,
        url: this.snowtraceUrl('token', commonTokens[0]),
      });
    }

    // Calculate total (weighted)
    const totalScore = Math.round(
      scores.sameFunder * 0.5 +
      scores.recipientOverlap * 0.3 +
      scores.tokenOverlap * 0.2
    );

    const confidence: ClusterConnection['confidence'] =
      totalScore >= 70 ? 'high' :
      totalScore >= 50 ? 'medium' : 'low';

    return {
      wallet: candidate,
      seedWallet: seedAddress.toLowerCase(),
      scores,
      totalScore,
      confidence,
      evidence,
    };
  }

  // ── Helper Methods ──────────────────────────────────────

  private async binarySearchFirstActivity(
    address: string,
    low: number,
    high: number,
  ): Promise<number | null> {
    // Check if there's any activity at all
    const transfers = await this.rpc.getTransfers(address, low, high);
    if (transfers.length === 0) return null;

    // Find earliest block from transfers
    let earliest = high;
    for (const t of transfers) {
      if (t.blockNumber < earliest) {
        earliest = t.blockNumber;
      }
    }

    return earliest;
  }

  private isExcluded(address: string): boolean {
    return this.EXCLUDED_ENTITIES.has(address.toLowerCase());
  }

  private snowtraceUrl(type: 'tx' | 'address' | 'token', hash: string): string {
    return `${this.SNOWTRACE_BASE}/${type}/${hash}`;
  }

  private async saveCluster(cluster: WalletCluster): Promise<void> {
    // Save cluster
    await this.memory.setCache(
      this.CLUSTER_PREFIX + cluster.id,
      JSON.stringify(cluster),
    );

    // Update cluster list
    const listData = await this.memory.getCached(this.CLUSTER_PREFIX + 'list');
    const list: string[] = listData ? JSON.parse(listData) : [];
    if (!list.includes(cluster.id)) {
      list.push(cluster.id);
      await this.memory.setCache(this.CLUSTER_PREFIX + 'list', JSON.stringify(list));
    }
  }

  // ── Formatting ──────────────────────────────────────────

  formatClusterSummary(cluster: WalletCluster): string {
    const lines: string[] = [];

    lines.push(`Cluster: ${cluster.seedTag} (${cluster.seedWallet.slice(0, 10)}...)`);
    lines.push(`ID: ${cluster.id}`);
    lines.push(`Members: ${cluster.members.length} wallets`);
    lines.push('');

    if (cluster.members.length === 0) {
      lines.push('No related wallets found above threshold.');
    } else {
      lines.push('Related wallets by score:');
      for (let i = 0; i < Math.min(cluster.members.length, 10); i++) {
        const m = cluster.members[i];
        const shortAddr = `${m.address.slice(0, 10)}...${m.address.slice(-6)}`;
        const conf = m.connection.confidence.toUpperCase();
        const verified = m.verified ? ' [VERIFIED]' : '';
        lines.push(`  ${i + 1}. ${shortAddr} [SCORE: ${m.connection.totalScore}] ${conf}${verified}`);

        // Show evidence summary
        for (const ev of m.connection.evidence.slice(0, 2)) {
          lines.push(`     - ${ev.description}`);
        }
        if (m.verificationNotes) {
          lines.push(`     - Notes: ${m.verificationNotes}`);
        }
      }
    }

    return lines.join('\n');
  }

  formatEvidence(member: ClusterMember): string {
    const lines: string[] = [];
    const c = member.connection;

    lines.push(`Evidence linking ${member.address.slice(0, 10)}... to cluster:`);
    lines.push('');

    if (c.scores.sameFunder > 0) {
      lines.push(`Same Funder (Score: ${c.scores.sameFunder}):`);
      const fundingEv = c.evidence.find(e => e.type === 'funding');
      if (fundingEv) {
        lines.push(`  ${fundingEv.description}`);
        lines.push(`  Proof: ${fundingEv.url}`);
      }
      lines.push('');
    }

    if (c.scores.recipientOverlap > 0) {
      lines.push(`Common Recipients (Score: ${c.scores.recipientOverlap}):`);
      const recipientEv = c.evidence.find(e => e.type === 'recipient');
      if (recipientEv) {
        lines.push(`  ${recipientEv.description}`);
        lines.push(`  Example: ${recipientEv.url}`);
      }
      lines.push('');
    }

    if (c.scores.tokenOverlap > 0) {
      lines.push(`Token Overlap (Score: ${c.scores.tokenOverlap}):`);
      const tokenEv = c.evidence.find(e => e.type === 'token');
      if (tokenEv) {
        lines.push(`  ${tokenEv.description}`);
        lines.push(`  Example: ${tokenEv.url}`);
      }
      lines.push('');
    }

    // External verification links
    lines.push('VERIFY EXTERNALLY:');
    lines.push(`  Debank: ${this.debankUrl(member.address)}`);
    lines.push(`  MetaSleuth: ${this.metasleuthUrl(member.address)}`);
    lines.push(`  Snowtrace: ${this.snowtraceUrl('address', member.address)}`);

    return lines.join('\n');
  }

  // ── URL Generators ──────────────────────────────────────

  private debankUrl(address: string): string {
    return `${this.DEBANK_BASE}/${address}`;
  }

  private metasleuthUrl(address: string): string {
    return `${this.METASLEUTH_BASE}/${address}`;
  }
}
