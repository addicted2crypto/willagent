import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import {
  agentConfig,
  claudeConfig,
  localModelConfig,
  turboModelConfig,
  openwebuiConfig,
  redisConfig,
  sandboxConfig,
} from '../config/configuration';
import { AgentModule } from './agent/agent.module';

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
      ],
      envFilePath: ['.env', '.env.local'],
    }),
    EventEmitterModule.forRoot(),
    AgentModule,
  ],
})
export class AppModule {}
