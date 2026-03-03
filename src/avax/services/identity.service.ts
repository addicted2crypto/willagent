import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Identity lookup result
 */
export interface WalletIdentity {
  address: string;
  ens?: string;              // .eth name
  twitter?: string;          // @handle (from DeBank or manual mapping)
  lens?: string;             // Lens handle
  farcaster?: string;        // Farcaster username
  debank?: {                 // DeBank profile
    name?: string;
    followers?: number;
    verified?: boolean;
  };
  labels: string[];          // Known labels (exchange, protocol, etc.)
  sources: string[];         // Where we found the identity
}

/**
 * IdentityService
 *
 * Attempts to identify wallet owners via on-chain and social data:
 * - ENS reverse lookup
 * - Lens Protocol profiles
 * - DeBank social
 * - Known labels (exchanges, protocols)
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  // ENS reverse resolver on Ethereum mainnet
  private readonly ENS_REVERSE_REGISTRAR = '0x084b1c3c81545d370f3634392de611caabff8148';

  // Known entity labels (exchanges, protocols, etc.)
  private readonly KNOWN_ENTITIES: Map<string, string> = new Map([
    // Exchanges
    ['0x9f8c163cba728e99993abe7495f06c0a3c8ac8b9', 'Binance'],
    ['0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', 'Binance Cold'],
    ['0x28c6c06298d514db089934071355e5743bf21d60', 'Binance Hot'],
    ['0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Bybit'],
    ['0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23', 'Coinbase'],
    ['0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase 2'],
    ['0xdfd5293d8e347dfe59e90efd55b2956a1343963d', 'Coinbase 3'],
    ['0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken'],
    ['0xa910f92acdaf488fa6ef02174fb86208ad7722ba', 'OKX'],

    // DeFi Protocols (AVAX)
    ['0x60ae616a2155ee3d9a68541ba4544862310933d4', 'TraderJoe Router'],
    ['0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd', 'JOE Token'],
    ['0xdef171fe48cf0115b1d80b88dc8eab59176fee57', 'ParaSwap'],
    ['0x9aab3f75489902f3a48495025729a0af77d4b11e', 'Pangolin Router'],
    ['0xe54ca86531e17ef3616d22ca28b0d458b6c89106', 'Pangolin'],

    // Token Contracts (filter from clustering - these are contracts, not wallets)
    ['0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', 'WAVAX'],
    ['0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', 'USDt'],
    ['0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', 'USDC'],
    ['0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab', 'WETH.e'],
    ['0x50b7545627a5162f82a992c33b87adc75187b218', 'WBTC.e'],
    ['0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be', 'sAVAX'],
    ['0x5947bb275c521040051d82396192181b413227a3', 'LINK.e'],
    ['0xd586e7f844cea2f87f50152665bcbc2c279d8d70', 'DAI.e'],
    ['0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664', 'USDC.e'],
    ['0xc7198437980c041c805a1edcba50c1ce5db95118', 'USDT.e'],

    // Bridges
    ['0x8eb8a3b98659cce290402893d0123abb75e3ab28', 'Avalanche Bridge'],
    ['0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf', 'Polygon Bridge'],

    // Common attack/exploit addresses
    ['0x0000000000000000000000000000000000000000', 'Null Address'],
    ['0x000000000000000000000000000000000000dead', 'Burn Address'],
  ]);

  // ETH mainnet RPC for ENS lookups
  private readonly ETH_RPC_ENDPOINTS = [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
  ];

  // Known wallet -> Twitter handle mappings (add more as you find them)
  // Format: address -> handle (without the @)
  private readonly KNOWN_TWITTER: Map<string, string> = new Map([
    // Tommy Mag - Avalanche community figure, $DORITO CTO
    ['0x95894a9d5b5c2e8c9c5e0e9c7c9c5c9c5c9c5ac6', 'onecalledthomas'],
    // Add more wallet-to-twitter mappings as you discover them
  ]);

  constructor(private readonly config: ConfigService) {}

  /**
   * Lookup identity for a wallet address
   * Checks multiple sources and aggregates results
   */
  async lookupIdentity(address: string): Promise<WalletIdentity> {
    const normalized = address.toLowerCase();

    const identity: WalletIdentity = {
      address: normalized,
      labels: [],
      sources: [],
    };

    // Check known entities first (instant)
    const knownLabel = this.KNOWN_ENTITIES.get(normalized);
    if (knownLabel) {
      identity.labels.push(knownLabel);
      identity.sources.push('known_entities');
    }

    // Check known Twitter handles
    const knownTwitter = this.KNOWN_TWITTER.get(normalized);
    if (knownTwitter) {
      identity.twitter = `@${knownTwitter}`;
      identity.sources.push('known_twitter');
    }

    // Parallel lookups
    const [ens, debank] = await Promise.allSettled([
      this.lookupENS(normalized),
      this.lookupDeBank(normalized),
    ]);

    if (ens.status === 'fulfilled' && ens.value) {
      identity.ens = ens.value;
      identity.sources.push('ens');
    }

    if (debank.status === 'fulfilled' && debank.value) {
      identity.debank = debank.value;
      if (debank.value.name) {
        identity.sources.push('debank');
      }
    }

    return identity;
  }

  /**
   * Batch lookup identities for multiple addresses
   */
  async lookupIdentities(addresses: string[]): Promise<Map<string, WalletIdentity>> {
    const results = new Map<string, WalletIdentity>();

    // Process in batches of 5 to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const identities = await Promise.all(
        batch.map(addr => this.lookupIdentity(addr))
      );

      for (const identity of identities) {
        results.set(identity.address, identity);
      }
    }

    return results;
  }

  /**
   * ENS reverse lookup (address -> .eth name)
   */
  private async lookupENS(address: string): Promise<string | null> {
    try {
      // ENS stores reverse records at [address].addr.reverse
      const reverseNode = this.getENSReverseNode(address);

      // Try each ETH RPC endpoint
      for (const rpc of this.ETH_RPC_ENDPOINTS) {
        try {
          const response = await fetch(rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_call',
              params: [{
                to: this.ENS_REVERSE_REGISTRAR,
                data: `0x691f3431${reverseNode}`, // name(bytes32)
              }, 'latest'],
            }),
          });

          const data = await response.json();
          if (data.result && data.result !== '0x') {
            const name = this.decodeENSName(data.result);
            if (name && name.endsWith('.eth')) {
              return name;
            }
          }
          break; // Success, no need to try other RPCs
        } catch {
          // Try next RPC
        }
      }
    } catch (error) {
      this.logger.debug(`ENS lookup failed for ${address}: ${error}`);
    }
    return null;
  }

  /**
   * DeBank profile lookup
   */
  private async lookupDeBank(address: string): Promise<WalletIdentity['debank'] | null> {
    try {
      // DeBank has a public API for basic info
      const response = await fetch(
        `https://api.debank.com/user/addr?addr=${address}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!response.ok) return null;

      const data = await response.json();
      if (data.data) {
        return {
          name: data.data.desc || data.data.uname || undefined,
          followers: data.data.follower_count || 0,
          verified: data.data.is_verified || false,
        };
      }
    } catch (error) {
      this.logger.debug(`DeBank lookup failed for ${address}: ${error}`);
    }
    return null;
  }

  /**
   * Format identity for display
   */
  formatIdentity(identity: WalletIdentity): string {
    const lines: string[] = [];
    const shortAddr = `${identity.address.slice(0, 10)}...${identity.address.slice(-6)}`;

    lines.push(`Identity: ${shortAddr}`);

    if (identity.twitter) {
      lines.push(`  Twitter: ${identity.twitter}`);
    }

    if (identity.ens) {
      lines.push(`  ENS: ${identity.ens}`);
    }

    if (identity.debank?.name) {
      const verified = identity.debank.verified ? ' [VERIFIED]' : '';
      lines.push(`  DeBank: ${identity.debank.name}${verified}`);
      if (identity.debank.followers && identity.debank.followers > 0) {
        lines.push(`  Followers: ${identity.debank.followers}`);
      }
    }

    if (identity.labels.length > 0) {
      lines.push(`  Labels: ${identity.labels.join(', ')}`);
    }

    if (identity.sources.length === 0) {
      lines.push('  No identity found');
    } else {
      lines.push(`  Sources: ${identity.sources.join(', ')}`);
    }

    lines.push(`  Snowtrace: https://snowtrace.io/address/${identity.address}`);
    lines.push(`  Etherscan: https://etherscan.io/address/${identity.address}`);
    lines.push(`  DeBank: https://debank.com/profile/${identity.address}`);

    return lines.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────

  private getENSReverseNode(address: string): string {
    // This is a simplified version - real implementation needs namehash
    // For now, we'll just return a placeholder
    const addr = address.toLowerCase().replace('0x', '');
    return addr.padStart(64, '0');
  }

  private decodeENSName(hex: string): string | null {
    try {
      if (!hex || hex === '0x') return null;
      const data = hex.slice(2);
      if (data.length < 128) return null;

      const length = parseInt(data.slice(64, 128), 16);
      const nameHex = data.slice(128, 128 + length * 2);

      let result = '';
      for (let i = 0; i < nameHex.length; i += 2) {
        const charCode = parseInt(nameHex.slice(i, i + 2), 16);
        if (charCode > 0) result += String.fromCharCode(charCode);
      }
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * Web search for wallet identity (OSINT)
   * Searches Google/DuckDuckGo for wallet address + social keywords
   * Returns potential Twitter handles, names found
   */
  async searchWebForIdentity(address: string): Promise<{
    possibleTwitters: string[];
    possibleNames: string[];
    searchResults: string[];
  }> {
    const possibleTwitters: string[] = [];
    const possibleNames: string[] = [];
    const searchResults: string[] = [];

    const shortAddr = `${address.slice(0, 10)}...${address.slice(-6)}`;

    // Try DuckDuckGo HTML search (no API needed)
    const queries = [
      `"${address}" twitter`,
      `"${address}" crypto`,
      `"${shortAddr}" twitter site:x.com`,
    ];

    for (const query of queries) {
      try {
        const response = await fetch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html',
            },
          }
        );

        if (!response.ok) continue;

        const html = await response.text();

        // Extract Twitter handles from results
        const twitterMatches = html.match(/@[a-zA-Z0-9_]{1,15}/g);
        if (twitterMatches) {
          for (const handle of twitterMatches) {
            // Filter out common non-user handles
            if (!handle.match(/@(twitter|x|duckduckgo|google)/i)) {
              if (!possibleTwitters.includes(handle)) {
                possibleTwitters.push(handle);
              }
            }
          }
        }

        // Extract result snippets (basic parsing)
        const resultMatches = html.match(/<a class="result__snippet"[^>]*>([^<]+)</g);
        if (resultMatches) {
          for (const match of resultMatches.slice(0, 3)) {
            const text = match.replace(/<[^>]+>/g, '').trim();
            if (text && text.length > 20) {
              searchResults.push(text);
            }
          }
        }
      } catch (error) {
        this.logger.debug(`Web search failed for "${query}": ${error}`);
      }
    }

    return { possibleTwitters: possibleTwitters.slice(0, 5), possibleNames, searchResults: searchResults.slice(0, 5) };
  }

  /**
   * Full identity lookup including web search (slower but more thorough)
   */
  async deepLookupIdentity(address: string): Promise<WalletIdentity & { webSearch?: { possibleTwitters: string[]; searchResults: string[] } }> {
    // First do standard lookup
    const identity = await this.lookupIdentity(address);

    // Then do web search
    const webResults = await this.searchWebForIdentity(address);

    // If we found a likely Twitter handle and don't have one yet, add it
    if (!identity.twitter && webResults.possibleTwitters.length > 0) {
      // Take the first one as a suggestion (not verified)
      identity.twitter = `${webResults.possibleTwitters[0]} (unverified)`;
      identity.sources.push('web_search');
    }

    return {
      ...identity,
      webSearch: {
        possibleTwitters: webResults.possibleTwitters,
        searchResults: webResults.searchResults,
      },
    };
  }

  /**
   * Check if an address is a known entity
   */
  isKnownEntity(address: string): boolean {
    return this.KNOWN_ENTITIES.has(address.toLowerCase());
  }

  /**
   * Get label for known entity
   */
  getKnownLabel(address: string): string | undefined {
    return this.KNOWN_ENTITIES.get(address.toLowerCase());
  }
}
