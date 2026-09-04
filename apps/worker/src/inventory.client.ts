import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import {
  INVENTORY_SERVICE_NAME,
  type CommitResponse,
  type InventoryServiceClient,
} from '@ticketing/contracts';
import { grpcClientDuration } from '@ticketing/otel';
import { firstValueFrom } from 'rxjs';
import { INVENTORY_CLIENT } from './tokens';

@Injectable()
export class InventoryClient implements OnModuleInit {
  private service!: InventoryServiceClient;

  constructor(@Inject(INVENTORY_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<InventoryServiceClient>(INVENTORY_SERVICE_NAME);
  }

  async commit(orderId: string): Promise<CommitResponse> {
    const start = process.hrtime.bigint();
    try {
      return await firstValueFrom(this.service.commit({ orderId }));
    } finally {
      grpcClientDuration.record(Number(process.hrtime.bigint() - start) / 1e6, {
        'rpc.service': INVENTORY_SERVICE_NAME,
        'rpc.method': 'commit',
      });
    }
  }
}
