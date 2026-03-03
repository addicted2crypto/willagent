/**
 * AVAX On-Chain Tracking Types
 */

// ── Wallet Tracking ────────────────────────────────────

export interface TrackedWallet {
  address: string;          // 0x... format (checksummed)
  tag: string;              // User label: "whale1", "degen", "dev"
  notes?: string;           // Optional notes
  createdAt: number;        // Unix timestamp
  lastSyncedAt: number;     // Last time we fetched data
  avaxBalance?: string;     // Native AVAX balance in wei
}

export interface WalletBalance {
  address: string;
  avax: string;             // In wei
  avaxFormatted: string;    // Human readable (e.g., "1.5 AVAX")
  tokens: TokenBalance[];
}

export interface TokenBalance {
  contractAddress: string;
  symbol: string;
  name: string;
  balance: string;          // Raw balance
  decimals: number;
  balanceFormatted: string; // Human readable
}

// ── Token Tracking ─────────────────────────────────────

export interface TokenInfo {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply?: string;
  deployer?: string;
  deployedAt?: number;      // Block number
  deployTxHash?: string;
}

export interface TokenTransfer {
  txHash: string;
  blockNumber: number;
  timestamp?: number;
  from: string;
  to: string;
  contractAddress: string;
  symbol?: string;
  value: string;            // Raw value
  valueFormatted?: string;  // Human readable
}

// ── Alerts ─────────────────────────────────────────────

export enum AlertType {
  WALLET_BUY = 'wallet_buy',        // Tracked wallet receives tokens
  WALLET_SELL = 'wallet_sell',      // Tracked wallet sends tokens
  NEW_TOKEN = 'new_token',          // New token deployed
  LARGE_TRANSFER = 'large_transfer', // Transfer above threshold
  WALLET_ACTIVE = 'wallet_active',  // Any activity on tracked wallet
}

export interface AlertRule {
  id: string;
  type: AlertType;
  enabled: boolean;
  wallets?: string[];       // Filter by specific wallets (if applicable)
  tokens?: string[];        // Filter by specific tokens (if applicable)
  minAvax?: number;         // Minimum AVAX value threshold
  createdAt: number;
  lastTriggeredAt?: number;
  triggerCount: number;
}

export interface TriggeredAlert {
  id: string;
  ruleId: string;
  type: AlertType;
  timestamp: number;
  data: {
    wallet?: string;
    walletTag?: string;
    token?: string;
    tokenSymbol?: string;
    amount?: string;
    txHash?: string;
    blockNumber?: number;
  };
  acknowledged: boolean;
}

// ── RPC Types ──────────────────────────────────────────

export interface RpcSource {
  name: string;
  url: string;
  priority: number;
  apiKey?: string;
}

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

export interface RpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

// ── Constants ──────────────────────────────────────────

export const AVAX_CONSTANTS = {
  // Well-known tokens on Avalanche C-Chain
  TOKENS: {
    WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    USDT: '0x9702230A8Ea53601f5cD2dc00fDbC13d4dF4A8c7',
    JOE: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
  },
  // ERC20 function selectors
  SELECTORS: {
    balanceOf: '0x70a08231',
    name: '0x06fdde03',
    symbol: '0x95d89b41',
    decimals: '0x313ce567',
    totalSupply: '0x18160ddd',
  },
  // Event topics
  TOPICS: {
    Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  },
  // Default RPC endpoints
  RPC: {
    mainnet: 'https://api.avax.network/ext/bc/C/rpc',
    testnet: 'https://api.avax-test.network/ext/bc/C/rpc',
  },
};

// ── Wallet Clustering ─────────────────────────────────

/**
 * Data collected for each wallet during clustering analysis
 */
export interface WalletClusterData {
  address: string;
  firstFunder: string | null;
  firstFundingTxHash: string | null;
  firstFundingBlock: number | null;
  recipients: Array<{ address: string; txCount: number }>;
  tokens: string[];  // Contract addresses held
  collectedAt: number;
}

/**
 * Connection between two wallets with scoring
 */
export interface ClusterConnection {
  wallet: string;
  seedWallet: string;
  scores: {
    sameFunder: number;       // 0-100: Same first funder
    recipientOverlap: number; // 0-100: Send to same places
    tokenOverlap: number;     // 0-100: Hold same tokens
  };
  totalScore: number;
  confidence: 'high' | 'medium' | 'low';
  evidence: Array<{
    type: 'funding' | 'recipient' | 'token';
    description: string;
    txHash?: string;
    url: string;  // Snowtrace link
  }>;
}

/**
 * A cluster of related wallets
 */
export interface WalletCluster {
  id: string;
  seedWallet: string;
  seedTag: string;
  members: ClusterMember[];
  createdAt: number;
  updatedAt: number;
  lastScannedBlock: number;
}

export interface ClusterMember {
  address: string;
  tag?: string;
  connection: ClusterConnection;
  addedAt: number;
  verified: boolean;           // User confirmed via external tools
  verificationNotes?: string;  // Notes from verification (e.g., "Confirmed via Debank - same NFTs")
}

/**
 * Block data with full transactions
 */
export interface BlockWithTxs {
  number: string;      // Hex
  hash: string;
  timestamp: string;   // Hex
  transactions: Array<{
    hash: string;
    from: string;
    to: string | null;
    value: string;     // Hex
    input: string;
    blockNumber: string;
  }>;
}
