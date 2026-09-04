import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { MetricsInterceptor } from './common/metrics.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // The payment webhook signature is computed over the exact bytes that were
    // sent. Any re-serialisation of the parsed body changes them, so the raw
    // buffer has to survive the body parser.
    rawBody: true,
  });

  app.setGlobalPrefix('', { exclude: [] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new DomainExceptionFilter());
  app.useGlobalInterceptors(app.get(MetricsInterceptor));
  app.enableCors({ origin: true, credentials: true });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('api').log(`listening on http://0.0.0.0:${port}`);
}

void bootstrap();
