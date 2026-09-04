import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Health only. The worker has no API; everything it does arrives over Kafka.
  await app.listen(Number(process.env.WORKER_PORT ?? 3002), '0.0.0.0');
  new Logger('worker').log('consumers started');
}

void bootstrap();
