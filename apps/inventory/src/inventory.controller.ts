import { status as GrpcStatus } from '@grpc/grpc-js';
import { Controller } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  InventoryServiceControllerMethods,
  type CommitRequest,
  type CommitResponse,
  type GetAvailabilityRequest,
  type GetAvailabilityResponse,
  type HoldRequest,
  type HoldResponse,
  type InventoryServiceController,
  type RegisterTicketTypeRequest,
  type ReleaseRequest,
  type ReleaseResponse,
  type TicketTypeInventory,
} from '@ticketing/contracts';
import { DomainError } from '@ticketing/domain';
import { InventoryService } from './inventory.service';

/**
 * Domain errors become gRPC statuses with the domain code preserved in the
 * message, so the calling service can branch on the code instead of parsing
 * prose. FAILED_PRECONDITION rather than INVALID_ARGUMENT for an oversell: the
 * request was well-formed, the world just changed underneath it.
 */
function toRpcException(err: unknown): RpcException {
  if (err instanceof DomainError) {
    const code =
      err.code === 'INSUFFICIENT_INVENTORY' || err.code === 'INVARIANT_VIOLATION'
        ? GrpcStatus.FAILED_PRECONDITION
        : GrpcStatus.INVALID_ARGUMENT;
    return new RpcException({
      code,
      message: `${err.code}: ${err.message}`,
      details: JSON.stringify(err.details),
    });
  }
  return new RpcException({
    code: GrpcStatus.INTERNAL,
    message: err instanceof Error ? err.message : 'inventory error',
  });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toRpcException(err);
  }
}

@Controller()
@InventoryServiceControllerMethods()
export class InventoryController implements InventoryServiceController {
  constructor(private readonly inventory: InventoryService) {}

  registerTicketType(request: RegisterTicketTypeRequest): Promise<TicketTypeInventory> {
    return guard(() => this.inventory.registerTicketType(request));
  }

  getAvailability(request: GetAvailabilityRequest): Promise<GetAvailabilityResponse> {
    return guard(() => this.inventory.getAvailability(request));
  }

  hold(request: HoldRequest): Promise<HoldResponse> {
    return guard(() => this.inventory.hold(request));
  }

  commit(request: CommitRequest): Promise<CommitResponse> {
    return guard(() => this.inventory.commit(request.orderId));
  }

  release(request: ReleaseRequest): Promise<ReleaseResponse> {
    return guard(() => this.inventory.release(request));
  }
}
