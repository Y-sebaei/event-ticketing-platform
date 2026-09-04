import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TOPICS } from '@ticketing/contracts';
import type {
  CommitResponse,
  GetAvailabilityRequest,
  GetAvailabilityResponse,
  HoldRequest,
  HoldResponse,
  RegisterTicketTypeRequest,
  ReleaseRequest,
  ReleaseResponse,
  TicketTypeInventory,
} from '@ticketing/contracts';
import { HOLD_TTL_MS, InsufficientInventoryError, InvariantViolationError } from '@ticketing/domain';
import { withSpan } from '@ticketing/otel';
import {
  enqueueOutbox,
  isCheckViolation,
  withTransaction,
  type Pool,
  type PoolClient,
} from '@ticketing/platform';
import { PG_POOL } from './database.module';

interface InventoryRow {
  ticket_type_id: string;
  event_id: string;
  quantity_total: number;
  quantity_reserved: number;
  quantity_sold: number;
}

function toProto(row: InventoryRow): TicketTypeInventory {
  return {
    ticketTypeId: row.ticket_type_id,
    eventId: row.event_id,
    quantityTotal: row.quantity_total,
    quantityReserved: row.quantity_reserved,
    quantitySold: row.quantity_sold,
    quantityAvailable: row.quantity_total - row.quantity_reserved - row.quantity_sold,
  };
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async registerTicketType(req: RegisterTicketTypeRequest): Promise<TicketTypeInventory> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<InventoryRow>(
        `INSERT INTO inventory.ticket_type_inventory (ticket_type_id, event_id, quantity_total)
         VALUES ($1, $2, $3)
         ON CONFLICT (ticket_type_id)
           DO UPDATE SET quantity_total = EXCLUDED.quantity_total, updated_at = now()
         RETURNING *`,
        [req.ticketTypeId, req.eventId, req.quantityTotal],
      );
      const row = rows[0]!;
      await this.writeLedger(client, row.ticket_type_id, 0, 0, 'register', req.ticketTypeId);
      await this.announce(client, row.event_id, 'register', [row]);
      return toProto(row);
    });
  }

  async getAvailability(req: GetAvailabilityRequest): Promise<GetAvailabilityResponse> {
    const ids = req.ticketTypeIds ?? [];
    const { rows } = ids.length
      ? await this.pool.query<InventoryRow>(
          `SELECT * FROM inventory.ticket_type_inventory WHERE ticket_type_id = ANY($1::uuid[])`,
          [ids],
        )
      : await this.pool.query<InventoryRow>(
          `SELECT * FROM inventory.ticket_type_inventory WHERE event_id = $1 ORDER BY ticket_type_id`,
          [req.eventId],
        );
    return { items: rows.map(toProto) };
  }

  /**
   * Places a hold. Idempotent on order_id: a retry finds the existing
   * reservations and reports `changed: false` rather than doubling the seats.
   *
   * Rows are locked in a deterministic order (sorted by ticket_type_id) so two
   * orders touching the same pair of ticket types cannot deadlock each other.
   */
  async hold(req: HoldRequest): Promise<HoldResponse> {
    try {
      return await withSpan(
        'inventory.hold',
        {
          'order.id': req.orderId,
          'event.id': req.eventId,
          'inventory.line_count': req.items.length,
        },
        async (span) => {
          const ttlMs = req.ttlSeconds > 0 ? req.ttlSeconds * 1000 : HOLD_TTL_MS;
          const expiresAt = new Date(Date.now() + ttlMs);

          return withTransaction(this.pool, async (client) => {
            const existing = await client.query<{ ticket_type_id: string; expires_at: Date }>(
              `SELECT ticket_type_id, expires_at FROM inventory.reservation WHERE order_id = $1`,
              [req.orderId],
            );

            if ((existing.rowCount ?? 0) > 0) {
              span.setAttribute('inventory.hold.replayed', true);
              const rows = await this.lockRows(
                client,
                existing.rows.map((r) => r.ticket_type_id),
              );
              return {
                orderId: req.orderId,
                changed: false,
                expiresAt: (existing.rows[0]?.expires_at ?? expiresAt).toISOString(),
                items: rows.map(toProto),
              };
            }

            const ids = req.items.map((i) => i.ticketTypeId).sort();
            const locked = await this.lockRows(client, ids);
            const byId = new Map(locked.map((r) => [r.ticket_type_id, r]));
            const updated: InventoryRow[] = [];

            for (const item of req.items) {
              const row = byId.get(item.ticketTypeId);
              if (!row) {
                throw new InsufficientInventoryError({ reason: 'unknown_ticket_type', ...item });
              }
              const available = row.quantity_total - row.quantity_reserved - row.quantity_sold;
              if (available < item.quantity) {
                throw new InsufficientInventoryError({
                  ticketTypeId: item.ticketTypeId,
                  requested: item.quantity,
                  available,
                });
              }

              const { rows } = await client.query<InventoryRow>(
                `UPDATE inventory.ticket_type_inventory
                    SET quantity_reserved = quantity_reserved + $2,
                        version = version + 1,
                        updated_at = now()
                  WHERE ticket_type_id = $1
                  RETURNING *`,
                [item.ticketTypeId, item.quantity],
              );
              updated.push(rows[0]!);

              await client.query(
                `INSERT INTO inventory.reservation (order_id, ticket_type_id, quantity, expires_at)
                 VALUES ($1, $2, $3, $4)`,
                [req.orderId, item.ticketTypeId, item.quantity, expiresAt],
              );
              await this.writeLedger(client, item.ticketTypeId, item.quantity, 0, 'hold', req.orderId);
            }

            await this.announce(client, req.eventId, 'hold', updated);
            span.setAttribute('inventory.hold.expires_at', expiresAt.toISOString());

            return {
              orderId: req.orderId,
              changed: true,
              expiresAt: expiresAt.toISOString(),
              items: updated.map(toProto),
            };
          });
        },
      );
    } catch (err) {
      // The CHECK constraint is the last line of defence. If it ever fires, an
      // unlocked write path exists somewhere, and that deserves a loud log.
      if (isCheckViolation(err)) {
        this.logger.error(`oversell prevented by database constraint for order ${req.orderId}`);
        throw new InvariantViolationError({ orderId: req.orderId, reason: 'check_constraint' });
      }
      throw err;
    }
  }

  /**
   * Turns a hold into a sale. Called by the fulfilment consumer, which will
   * call it again for the same order whenever Kafka redelivers, so the second
   * call must be a no-op that reports the same numbers.
   */
  async commit(orderId: string): Promise<CommitResponse> {
    return withSpan('inventory.commit', { 'order.id': orderId }, async (span) =>
      withTransaction(this.pool, async (client) => {
        const reservations = await client.query<{
          ticket_type_id: string;
          quantity: number;
          state: string;
        }>(
          `SELECT ticket_type_id, quantity, state
             FROM inventory.reservation
            WHERE order_id = $1
            ORDER BY ticket_type_id
            FOR UPDATE`,
          [orderId],
        );

        if ((reservations.rowCount ?? 0) === 0) {
          throw new InvariantViolationError({ reason: 'commit_without_hold', orderId });
        }

        // Check the full set, not the held subset: a released reservation is
        // exactly what must not be committed, and filtering first would mean
        // this branch could never fire.
        if (reservations.rows.some((r) => r.state === 'released')) {
          throw new InvariantViolationError({ reason: 'commit_after_release', orderId });
        }

        const pending = reservations.rows.filter((r) => r.state === 'held');

        if (pending.length === 0) {
          span.setAttribute('inventory.commit.replayed', true);
          const rows = await this.lockRows(
            client,
            reservations.rows.map((r) => r.ticket_type_id),
          );
          return { orderId, changed: false, items: rows.map(toProto) };
        }

        const updated: InventoryRow[] = [];
        for (const reservation of pending) {
          const { rows } = await client.query<InventoryRow>(
            `UPDATE inventory.ticket_type_inventory
                SET quantity_reserved = quantity_reserved - $2,
                    quantity_sold     = quantity_sold + $2,
                    version           = version + 1,
                    updated_at        = now()
              WHERE ticket_type_id = $1
              RETURNING *`,
            [reservation.ticket_type_id, reservation.quantity],
          );
          updated.push(rows[0]!);
          await this.writeLedger(
            client,
            reservation.ticket_type_id,
            -reservation.quantity,
            reservation.quantity,
            'commit',
            orderId,
          );
        }

        await client.query(
          `UPDATE inventory.reservation
              SET state = 'committed', updated_at = now()
            WHERE order_id = $1 AND state = 'held'`,
          [orderId],
        );

        await this.announce(client, updated[0]!.event_id, 'commit', updated);
        return { orderId, changed: true, items: updated.map(toProto) };
      }),
    );
  }

  /** Returns held seats to the pool. Idempotent for the same reason commit is. */
  async release(req: ReleaseRequest): Promise<ReleaseResponse> {
    return withSpan(
      'inventory.release',
      { 'order.id': req.orderId, 'inventory.release.reason': req.reason || 'unspecified' },
      async () =>
        withTransaction(this.pool, async (client) => {
          const reservations = await client.query<{ ticket_type_id: string; quantity: number }>(
            `SELECT ticket_type_id, quantity
               FROM inventory.reservation
              WHERE order_id = $1 AND state = 'held'
              ORDER BY ticket_type_id
              FOR UPDATE`,
            [req.orderId],
          );

          if ((reservations.rowCount ?? 0) === 0) {
            return { orderId: req.orderId, changed: false, items: [] };
          }

          const updated: InventoryRow[] = [];
          for (const reservation of reservations.rows) {
            const { rows } = await client.query<InventoryRow>(
              `UPDATE inventory.ticket_type_inventory
                  SET quantity_reserved = quantity_reserved - $2,
                      version = version + 1,
                      updated_at = now()
                WHERE ticket_type_id = $1
                RETURNING *`,
              [reservation.ticket_type_id, reservation.quantity],
            );
            updated.push(rows[0]!);
            await this.writeLedger(
              client,
              reservation.ticket_type_id,
              -reservation.quantity,
              0,
              req.reason === 'expired' ? 'expire' : 'release',
              req.orderId,
            );
          }

          await client.query(
            `UPDATE inventory.reservation
                SET state = 'released', updated_at = now()
              WHERE order_id = $1 AND state = 'held'`,
            [req.orderId],
          );

          await this.announce(client, updated[0]!.event_id, 'release', updated);
          return { orderId: req.orderId, changed: true, items: updated.map(toProto) };
        }),
    );
  }

  /** Sweeps holds whose TTL has passed. Returns the orders it released. */
  async releaseExpired(limit = 100): Promise<string[]> {
    const { rows } = await this.pool.query<{ order_id: string }>(
      `SELECT DISTINCT order_id
         FROM inventory.reservation
        WHERE state = 'held' AND expires_at <= now()
        LIMIT $1`,
      [limit],
    );

    const released: string[] = [];
    for (const row of rows) {
      const result = await this.release({ orderId: row.order_id, reason: 'expired' });
      if (result.changed) released.push(row.order_id);
    }
    return released;
  }

  private async lockRows(client: PoolClient, ticketTypeIds: string[]): Promise<InventoryRow[]> {
    if (ticketTypeIds.length === 0) return [];
    const { rows } = await client.query<InventoryRow>(
      `SELECT * FROM inventory.ticket_type_inventory
        WHERE ticket_type_id = ANY($1::uuid[])
        ORDER BY ticket_type_id
        FOR UPDATE`,
      [ticketTypeIds],
    );
    return rows;
  }

  private async writeLedger(
    client: PoolClient,
    ticketTypeId: string,
    deltaReserved: number,
    deltaSold: number,
    reason: string,
    refId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO inventory.ledger (ticket_type_id, delta_reserved, delta_sold, reason, ref_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [ticketTypeId, deltaReserved, deltaSold, reason, refId],
    );
  }

  /**
   * Announces a change through the outbox, inside the caller's transaction. The
   * API consumes this topic and pushes to every connected browser, which is how
   * two tabs watch the same number drop at the same moment.
   */
  private async announce(
    client: PoolClient,
    eventId: string,
    reason: 'hold' | 'commit' | 'release' | 'register',
    rows: InventoryRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await enqueueOutbox(client, {
      schema: 'inventory',
      aggregateType: 'ticket_type_inventory',
      aggregateId: eventId,
      topic: TOPICS.INVENTORY_CHANGED,
      messageKey: eventId,
      messageId: randomUUID(),
      type: 'inventory.changed',
      payload: {
        eventId,
        reason,
        items: rows.map((r) => ({
          ticketTypeId: r.ticket_type_id,
          quantityAvailable: r.quantity_total - r.quantity_reserved - r.quantity_sold,
          quantityTotal: r.quantity_total,
        })),
      },
    });
  }
}
