/**
 * Domain errors carry a stable `code` because they cross three boundaries:
 * HTTP responses, gRPC status details, and Kafka dead-letter payloads. Callers
 * branch on the code, never on the message.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidQuantityError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('INVALID_QUANTITY', 'Requested quantity is not valid for this ticket type', details);
  }
}

export class OrderTooLargeError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('ORDER_TOO_LARGE', 'Order exceeds the maximum number of tickets', details);
  }
}

export class InsufficientInventoryError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('INSUFFICIENT_INVENTORY', 'Not enough tickets remain', details);
  }
}

export class InvariantViolationError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('INVARIANT_VIOLATION', 'Inventory invariant would be violated', details);
  }
}

export class IllegalTransitionError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('ILLEGAL_TRANSITION', 'Order cannot move between those states', details);
  }
}

export class InvalidIdempotencyKeyError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('INVALID_IDEMPOTENCY_KEY', 'Idempotency key is malformed', details);
  }
}

export class SalesWindowClosedError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('SALES_WINDOW_CLOSED', 'Tickets are not on sale at this time', details);
  }
}
