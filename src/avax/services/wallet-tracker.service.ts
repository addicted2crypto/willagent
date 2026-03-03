import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MemoryService } from '../../memory/memory.service';
import { AvaxRpcService } from './avax-rpc.service';
import { TrackedWallet, WalletBalance } from '../interfaces/avax.types';

/**
 * WalletTrackerService
 *
 * Manages tracked wallets with persistence via MemoryService (Redis/in-memory).
 */
@Injectable()
export class WalletTrackerService implements OnModuleInit {
  private readonly logger = new Logger(WalletTrackerService.name);
  private readonly PREFIX = 'avax:wallet:';
  private readonly LIST_KEY = 'avax:wallet:list';

  constructor(
    private readonly memory: MemoryService,
    private readonly rpc: AvaxRpcService,
  ) {}

  async onModuleInit() {
    const wallets = await this.listWallets();
    this.logger.log(`Loaded ${wallets.length} tracked wallet(s)`);
  }

  /**
   * Track a new wallet
   */
  async trackWallet(address: string, tag: string, notes?: string): Promise<TrackedWallet> {
    const normalizedAddress = address.toLowerCase();

    // Check if already tracked
    const existing = await this.getWallet(normalizedAddress);
    if (existing) {
      // Update tag/notes
      existing.tag = tag;
      existing.notes = notes;
      await this.saveWallet(existing);
      return existing;
    }

    const wallet: TrackedWallet = {
      address: normalizedAddress,
      tag,
      notes,
      createdAt: Date.now(),
      lastSyncedAt: Date.now(),
    };

    await this.saveWallet(wallet);
    await this.addToList(normalizedAddress);

    this.logger.log(`Tracking wallet: ${normalizedAddress} as "${tag}"`);
    return wallet;
  }

  /**
   * Stop tracking a wallet
   */
  async untrackWallet(address: string): Promise<boolean> {
    const normalizedAddress = address.toLowerCase();
    const key = this.PREFIX + normalizedAddress;

    const existing = await this.getWallet(normalizedAddress);
    if (!existing) return false;

    await this.memory.deleteCache(key);
    await this.removeFromList(normalizedAddress);

    this.logger.log(`Stopped tracking wallet: ${normalizedAddress}`);
    return true;
  }

  /**
   * Get a tracked wallet by address
   */
  async getWallet(address: string): Promise<TrackedWallet | null> {
    const normalizedAddress = address.toLowerCase();
    const key = this.PREFIX + normalizedAddress;
    const data = await this.memory.getCached(key);

    if (!data) return null;
    return JSON.parse(data) as TrackedWallet;
  }

  /**
   * Get a tracked wallet by tag
   */
  async getWalletByTag(tag: string): Promise<TrackedWallet | null> {
    const wallets = await this.listWallets();
    return wallets.find(w => w.tag.toLowerCase() === tag.toLowerCase()) ?? null;
  }

  /**
   * List all tracked wallets
   */
  async listWallets(): Promise<TrackedWallet[]> {
    const listData = await this.memory.getCached(this.LIST_KEY);
    if (!listData) return [];

    const addresses: string[] = JSON.parse(listData);
    const wallets: TrackedWallet[] = [];

    for (const address of addresses) {
      const wallet = await this.getWallet(address);
      if (wallet) wallets.push(wallet);
    }

    return wallets;
  }

  /**
   * Get balance for a tracked wallet (or any address)
   */
  async getBalance(addressOrTag: string): Promise<WalletBalance | null> {
    let address = addressOrTag;

    // Check if it's a tag
    if (!addressOrTag.startsWith('0x')) {
      const wallet = await this.getWalletByTag(addressOrTag);
      if (!wallet) return null;
      address = wallet.address;
    }

    return this.rpc.getWalletBalance(address);
  }

  /**
   * Sync a wallet (refresh balance data)
   */
  async syncWallet(address: string): Promise<TrackedWallet | null> {
    const normalizedAddress = address.toLowerCase();
    const wallet = await this.getWallet(normalizedAddress);

    if (!wallet) return null;

    // Fetch current balance
    const balance = await this.rpc.getBalance(normalizedAddress);
    wallet.avaxBalance = balance;
    wallet.lastSyncedAt = Date.now();

    await this.saveWallet(wallet);
    return wallet;
  }

  // ── Private Helpers ──────────────────────────────────

  private async saveWallet(wallet: TrackedWallet): Promise<void> {
    const key = this.PREFIX + wallet.address;
    await this.memory.setCache(key, JSON.stringify(wallet));
  }

  private async addToList(address: string): Promise<void> {
    const listData = await this.memory.getCached(this.LIST_KEY);
    const list: string[] = listData ? JSON.parse(listData) : [];

    if (!list.includes(address)) {
      list.push(address);
      await this.memory.setCache(this.LIST_KEY, JSON.stringify(list));
    }
  }

  private async removeFromList(address: string): Promise<void> {
    const listData = await this.memory.getCached(this.LIST_KEY);
    if (!listData) return;

    const list: string[] = JSON.parse(listData);
    const filtered = list.filter(a => a !== address);
    await this.memory.setCache(this.LIST_KEY, JSON.stringify(filtered));
  }
}
