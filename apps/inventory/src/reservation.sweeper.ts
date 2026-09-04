import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InventoryService } from './inventory.service';

/**
 * Holds have a TTL, so something has to collect them. Without this, a customer
 * who opens checkout and closes the tab keeps those seats out of circulation
 * forever — the cost of choosing holds over decrement-on-purchase, paid here.
 *
 * It runs in the inventory service rather than as a cron container because it
 * is the same write path as `release`, and the service that owns the data
 * should be the one repairing it.
 */
@Injectable()
export class ReservationSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReservationSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly inventory: InventoryService) {}

  onApplicationBootstrap(): void {
    const intervalMs = Number(process.env.RESERVATION_SWEEP_INTERVAL_MS ?? 15_000);
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    try {
      const released = await this.inventory.releaseExpired();
      if (released.length > 0) {
        this.logger.log(`released ${released.length} expired hold(s): ${released.join(', ')}`);
      }
    } catch (err) {
      this.logger.error(`sweep failed: ${(err as Error).message}`);
    }
  }
}
