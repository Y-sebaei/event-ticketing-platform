import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from '@ticketing/platform';
import { PG_POOL } from './app.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const { rows } = await this.pool.query<{ pending: string }>(
      `SELECT count(*)::text AS pending FROM ordering.outbox WHERE published_at IS NULL`,
    );
    return { status: 'ok', service: 'worker', outboxPending: Number(rows[0]?.pending ?? 0) };
  }
}
