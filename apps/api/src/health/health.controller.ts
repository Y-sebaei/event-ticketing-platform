import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Client as ElasticClient } from '@elastic/elasticsearch';
import type { Pool } from '@ticketing/platform';
import { ELASTIC_CLIENT, PG_POOL } from '../common/infra.module';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ELASTIC_CLIENT) private readonly elastic: ElasticClient,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness fails only on Postgres. Elasticsearch being down degrades search
   * to the database listing rather than taking the whole API out of rotation —
   * a browse page that works without search is better than no browse page.
   */
  @Get('ready')
  async ready() {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      throw new ServiceUnavailableException({ postgres: (err as Error).message });
    }

    let search = 'ok';
    try {
      await this.elastic.ping();
    } catch {
      search = 'degraded';
    }

    return { status: 'ok', service: 'api', dependencies: { postgres: 'ok', search } };
  }
}
