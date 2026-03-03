import { Injectable, Logger } from '@nestjs/common';

/**
 * CommandParserService - Intent-Based Parser
 *
 * SIMPLE RULES:
 * 1. See address? → Cluster it (find related wallets)
 * 2. See tag name + address? → Cluster + tag
 * 3. See "tag" or "track"? → Track the wallet
 * 4. See "list"? → Show tracked wallets
 * 5. See "view <name>"? → Show that cluster
 *
 * NO MORE LLM CONFUSION.
 */

export interface ParsedCommand {
  tool: string;
  action: string;
  args: Record<string, unknown>;
  raw: string;
}

// Known wallet aliases (grows as we tag)
const KNOWN_WALLETS: Record<string, string> = {
  'hashcash': '0x074afbac79ab82bd11b69037b8241dc5d292bce6',
  'vroshi55': '0x168e8d263634ef25ef84a643d231ae39ceb75909',
  'vroshi': '0x168e8d263634ef25ef84a643d231ae39ceb75909',
};

@Injectable()
export class CommandParserService {
  private readonly logger = new Logger(CommandParserService.name);

  /**
   * Parse user input and determine what to do.
   * Returns null ONLY if we truly don't understand.
   */
  parse(input: string): ParsedCommand | null {
    const text = input.trim().toLowerCase();

    // Extract any wallet addresses
    const addresses = this.extractAddresses(input);

    // Extract potential tag names (quoted strings or capitalized words)
    const tag = this.extractTagName(input);

    // Extract twitter handle if present
    const twitter = this.extractTwitter(input);

    this.logger.debug(`Parsed: addresses=${addresses.join(',')}, tag=${tag}, twitter=${twitter}`);

    // ═══════════════════════════════════════════════════════════
    // RULE 1: "list" command - show tracked wallets
    // ═══════════════════════════════════════════════════════════
    if (/^list\b/.test(text) || text === 'ls' || text === 'wallets') {
      return {
        tool: 'avax_wallet',
        action: 'list',
        args: { action: 'list' },
        raw: input,
      };
    }

    // ═══════════════════════════════════════════════════════════
    // RULE 2: "view <tag>" - show existing cluster
    // ═══════════════════════════════════════════════════════════
    const viewMatch = text.match(/^(?:view|show|get)\s+(?:cluster\s+)?(\w+)/);
    if (viewMatch && !addresses.length) {
      const clusterName = viewMatch[1];
      // Check if it's a known wallet alias
      if (KNOWN_WALLETS[clusterName]) {
        return {
          tool: 'avax_cluster',
          action: 'smart',
          args: { action: 'smart', address: KNOWN_WALLETS[clusterName], tag: clusterName },
          raw: input,
        };
      }
      return {
        tool: 'avax_cluster',
        action: 'view',
        args: { action: 'view', id: clusterName },
        raw: input,
      };
    }

    // ═══════════════════════════════════════════════════════════
    // RULE 3: Has address → CLUSTER IT (our main use case)
    // ═══════════════════════════════════════════════════════════
    if (addresses.length > 0) {
      const primaryAddress = addresses[0];

      // Check if they want to track/tag
      const wantsTrack = /\b(track|tag|save|add|name)\b/i.test(text);

      if (wantsTrack && tag) {
        // Add to known wallets for future reference
        KNOWN_WALLETS[tag.toLowerCase()] = primaryAddress;

        return {
          tool: 'avax_cluster',
          action: 'smart',
          args: {
            action: 'smart',
            address: primaryAddress,
            tag,
            ...(twitter && { twitter }),
          },
          raw: input,
        };
      }

      // Just cluster it - find related wallets
      return {
        tool: 'avax_cluster',
        action: 'smart',
        args: {
          action: 'smart',
          address: primaryAddress,
          ...(tag && { tag }),
        },
        raw: input,
      };
    }

    // ═══════════════════════════════════════════════════════════
    // RULE 4: Known wallet name mentioned → CLUSTER IT
    // ═══════════════════════════════════════════════════════════
    for (const [name, address] of Object.entries(KNOWN_WALLETS)) {
      if (text.includes(name)) {
        return {
          tool: 'avax_cluster',
          action: 'smart',
          args: { action: 'smart', address, tag: name },
          raw: input,
        };
      }
    }

    // ═══════════════════════════════════════════════════════════
    // RULE 5: "cluster <something>" - try to resolve it
    // ═══════════════════════════════════════════════════════════
    const clusterMatch = text.match(/cluster\s+(\S+)/);
    if (clusterMatch) {
      const target = clusterMatch[1];
      const resolved = this.resolveAddress(target);
      if (resolved) {
        return {
          tool: 'avax_cluster',
          action: 'smart',
          args: { action: 'smart', address: resolved, tag: target },
          raw: input,
        };
      }
    }

    // ═══════════════════════════════════════════════════════════
    // RULE 6: Help or unknown
    // ═══════════════════════════════════════════════════════════
    if (/^(help|commands|\?|h)$/i.test(text)) {
      return {
        tool: 'help',
        action: 'show',
        args: {},
        raw: input,
      };
    }

    // No match - return null to let LLM try
    // But log it so we can improve
    this.logger.warn(`Could not parse: "${input}"`);
    return null;
  }

  /**
   * Extract all wallet addresses from input
   */
  private extractAddresses(input: string): string[] {
    const pattern = /0x[a-fA-F0-9]{40}/gi;
    const matches = input.match(pattern) || [];
    return [...new Set(matches.map(a => a.toLowerCase()))];
  }

  /**
   * Extract a tag name from input
   * Looks for: quoted strings, "as <name>", "called <name>", "named <name>"
   */
  private extractTagName(input: string): string | null {
    // Quoted string: "foo" or 'foo'
    const quotedMatch = input.match(/["']([^"']+)["']/);
    if (quotedMatch) return quotedMatch[1];

    // "as <name>" pattern
    const asMatch = input.match(/\b(?:as|called|named|name(?:d)?)\s+(\w+)/i);
    if (asMatch) return asMatch[1];

    // "tag <name>" when there's also an address
    const tagMatch = input.match(/\btag\s+(?:all\s+)?(?:wallets?\s+)?(?:of\s+)?(\w+)/i);
    if (tagMatch && !tagMatch[1].match(/^0x/i)) return tagMatch[1];

    // "<name>'s wallet" pattern
    const possessiveMatch = input.match(/(\w+)['']s\s+wallet/i);
    if (possessiveMatch) return possessiveMatch[1];

    return null;
  }

  /**
   * Extract twitter handle
   */
  private extractTwitter(input: string): string | null {
    // @handle pattern
    const atMatch = input.match(/@(\w+)/);
    if (atMatch) return `@${atMatch[1]}`;

    // "twitter <handle>" pattern
    const twitterMatch = input.match(/twitter\s+@?(\w+)/i);
    if (twitterMatch) return `@${twitterMatch[1]}`;

    return null;
  }

  /**
   * Resolve a string to a wallet address
   */
  resolveAddress(input: string): string | null {
    const trimmed = input.trim().toLowerCase();

    // Direct address
    if (/^0x[a-fA-F0-9]{40}$/i.test(trimmed)) {
      return trimmed;
    }

    // Known alias
    if (KNOWN_WALLETS[trimmed]) {
      return KNOWN_WALLETS[trimmed];
    }

    return null;
  }

  /**
   * Add a wallet alias (called when we tag)
   */
  addAlias(name: string, address: string): void {
    KNOWN_WALLETS[name.toLowerCase()] = address.toLowerCase();
    this.logger.log(`Added alias: ${name} → ${address}`);
  }

  /**
   * Get known wallet aliases
   */
  getKnownWallets(): Record<string, string> {
    return { ...KNOWN_WALLETS };
  }
}
