import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness checks the database, because an inventory service that cannot
   * reach Postgres can answer nothing useful and should not be routed to.
   */
  @Get('ready')
  async ready() {
    await this.pool.query('SELECT 1');
    return { status: 'ok', service: 'inventory' };
  }
}
