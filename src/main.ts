import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { LoggerService } from './common/logger/logger.service';

async function bootstrap() {
  // Create app with buffered logs (we'll attach winston after)
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // Use our winston-based logger for all NestJS logs
  // resolve() required because LoggerService is TRANSIENT scoped
  const logger = await app.resolve(LoggerService);
  logger.setContext('Bootstrap');
  app.useLogger(logger);

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  // Swagger API docs
  const config = new DocumentBuilder()
    .setTitle('WillAgent')
    .setDescription('Self-hosted AI agent orchestrator with multi-model routing')
    .setVersion('0.1.0')
    .addTag('agent')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT ?? 3100;
  await app.listen(port);

  logger.log(`WillAgent running on http://localhost:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
