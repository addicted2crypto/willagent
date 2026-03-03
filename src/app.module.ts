import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import {
  agentConfig,
  claudeConfig,
  localModelConfig,
  turboModelConfig,
  openwebuiConfig,
  redisConfig,
  sandboxConfig,
  avaxConfig,
} from '../config/configuration';
import { AgentModule } from './agent/agent.module';
import { AvaxModule } from './avax/avax.module';
import { LoggerModule } from './common/logger/logger.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        agentConfig,
        claudeConfig,
        localModelConfig,
        turboModelConfig,
        openwebuiConfig,
        redisConfig,
        sandboxConfig,
        avaxConfig,
      ],
      envFilePath: ['.env', '.env.local'],
    }),
    EventEmitterModule.forRoot(),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      exclude: ['/api*', '/docs*'],
    }),
    LoggerModule,
    AgentModule,
    AvaxModule,
  ],
})
export class AppModule {}
