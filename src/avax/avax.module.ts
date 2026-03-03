import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { ToolsModule } from '../tools/tools.module';

// Services
import { AvaxRpcService } from './services/avax-rpc.service';
import { WalletTrackerService } from './services/wallet-tracker.service';
import { WalletProfilerService } from './services/wallet-profiler.service';
import { WalletClusterService } from './services/wallet-cluster.service';
import { PortfolioApiService } from './services/portfolio-api.service';
import { IdentityService } from './services/identity.service';

// Tools
import { AvaxWalletTool } from './tools/avax-wallet.tool';
import { AvaxProfileTool } from './tools/avax-profile.tool';
import { AvaxClusterTool } from './tools/avax-cluster.tool';

/**
 * AvaxModule
 *
 * Provides AVAX C-Chain intelligence capabilities:
 * - Wallet tracking and tagging
 * - Balance queries (native + tokens)
 * - Transfer activity monitoring
 * - Wallet profiling and smart money scoring
 * - Find buyers for tokens
 * - Wallet clustering (find related wallets)
 */
@Module({
  imports: [MemoryModule, ToolsModule],
  providers: [
    // Services
    AvaxRpcService,
    PortfolioApiService,
    WalletTrackerService,
    WalletProfilerService,
    WalletClusterService,
    IdentityService,
    // Tools (self-register via onModuleInit)
    AvaxWalletTool,
    AvaxProfileTool,
    AvaxClusterTool,
  ],
  exports: [AvaxRpcService, PortfolioApiService, WalletTrackerService, WalletProfilerService, WalletClusterService, IdentityService],
})
export class AvaxModule {}
