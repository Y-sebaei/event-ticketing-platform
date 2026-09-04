import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import {
  INVENTORY_SERVICE_NAME,
  type CommitResponse,
  type GetAvailabilityResponse,
  type HoldRequest,
  type HoldResponse,
  type InventoryServiceClient,
  type RegisterTicketTypeRequest,
  type ReleaseResponse,
  type TicketTypeInventory,
} from '@ticketing/contracts';
import { grpcClientDuration } from '@ticketing/otel';
import { firstValueFrom } from 'rxjs';
import { INVENTORY_CLIENT } from './infra.module';

/**
 * A thin, typed wrapper so callers deal in promises and never touch rxjs.
 *
 * The generated `InventoryServiceClient` interface is the contract: change the
 * .proto without regenerating and this file stops compiling, which is the whole
 * argument for gRPC on this call. A JSON API would have failed at runtime, in
 * production, on a field nobody noticed was renamed.
 */
@Injectable()
export class InventoryClient implements OnModuleInit {
  private service!: InventoryServiceClient;

  constructor(@Inject(INVENTORY_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<InventoryServiceClient>(INVENTORY_SERVICE_NAME);
  }

  private async timed<T>(method: string, run: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    let outcome = 'ok';
    try {
      return await run();
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      grpcClientDuration.record(Number(process.hrtime.bigint() - start) / 1e6, {
        'rpc.service': INVENTORY_SERVICE_NAME,
        'rpc.method': method,
        outcome,
      });
    }
  }

  registerTicketType(request: RegisterTicketTypeRequest): Promise<TicketTypeInventory> {
    return this.timed('registerTicketType', () =>
      firstValueFrom(this.service.registerTicketType(request)),
    );
  }

  availabilityForEvent(eventId: string): Promise<GetAvailabilityResponse> {
    return this.timed('getAvailability', () =>
      firstValueFrom(this.service.getAvailability({ eventId, ticketTypeIds: [] })),
    );
  }

  hold(request: HoldRequest): Promise<HoldResponse> {
    return this.timed('hold', () => firstValueFrom(this.service.hold(request)));
  }

  commit(orderId: string): Promise<CommitResponse> {
    return this.timed('commit', () => firstValueFrom(this.service.commit({ orderId })));
  }

  release(orderId: string, reason: string): Promise<ReleaseResponse> {
    return this.timed('release', () => firstValueFrom(this.service.release({ orderId, reason })));
  }
}
