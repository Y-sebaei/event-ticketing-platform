import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { GRPC_LOADER_OPTIONS, INVENTORY_PACKAGE, inventoryProtoPath } from '@ticketing/contracts';
import { AppModule } from './app.module';

/**
 * A hybrid application: gRPC is the service's real interface, and a tiny HTTP
 * listener exists solely so Docker has something to health-check. The HTTP port
 * is not published in docker-compose, so nothing outside the network can reach
 * either one.
 */
async function bootstrap() {
  const logger = new Logger('inventory');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: INVENTORY_PACKAGE,
      protoPath: inventoryProtoPath(),
      url: '0.0.0.0:50051',
      loader: { ...GRPC_LOADER_OPTIONS },
    },
  });

  app.enableShutdownHooks();
  await app.startAllMicroservices();
  await app.listen(Number(process.env.HEALTH_PORT ?? 3003));

  logger.log(`gRPC listening on 0.0.0.0:50051 (package ${INVENTORY_PACKAGE})`);
}

void bootstrap();
