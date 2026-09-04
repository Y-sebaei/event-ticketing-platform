import { expect, test } from '@playwright/test';
import { API, checkoutViaApi, completePayment, firstAvailableTicketType, sessionIdFrom, waitForCatalog, waitForOrderStatus } from './helpers';

const TEMPO = process.env.E2E_TEMPO_URL ?? 'http://localhost:3200';
const PROMETHEUS = process.env.E2E_PROMETHEUS_URL ?? 'http://localhost:9090';

/**
 * Observability is the headline claim of this project, so it is tested rather
 * than asserted in a README. These tests fail if the trace stops at the Kafka
 * boundary — which is precisely the thing that is easy to get wrong and easy to
 * not notice.
 */
test.describe('observability', () => {
  test.beforeEach(async ({ request }) => {
    await waitForCatalog(request);
  });

  test('a checkout produces one trace that spans the API, gRPC and the consumer', async ({ request }) => {
    const { event, ticketType } = await firstAvailableTicketType(request, 'ostkreuz-techno-marathon');

    const order = await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity: 1,
      email: `trace+${Date.now()}@example.berlin`,
      idempotencyKey: `e2e-trace-${Date.now()}`,
    });

    expect(order.traceId, 'checkout should return its trace id').toBeTruthy();

    await completePayment(request, {
      sessionId: sessionIdFrom(order.paymentUrl),
      orderId: order.orderId,
      outcome: 'succeeded',
    });
    await waitForOrderStatus(request, order, 'fulfilled');

    // Tempo needs a moment to ingest, and the trace is only complete once the
    // consumer's spans have been flushed.
    let services: string[] = [];
    await expect
      .poll(
        async () => {
          const response = await request.get(`${TEMPO}/api/traces/${order.traceId}`);
          if (!response.ok()) return [];
          const body = await response.json();
          const batches = body?.batches ?? [];
          services = batches
            .map((batch: { resource?: { attributes?: { key: string; value: { stringValue?: string } }[] } }) =>
              batch.resource?.attributes?.find((a) => a.key === 'service.name')?.value?.stringValue,
            )
            .filter(Boolean) as string[];
          return services;
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toContain('api');

    // The whole point: the consumer's work is in the same trace as the HTTP
    // request that started it.
    expect(services, `trace ${order.traceId} did not reach the inventory service`).toContain('inventory');
    expect(services, `trace ${order.traceId} did not cross the Kafka boundary`).toContain('worker');
  });

  test('RED metrics are exported per route with a bounded label set', async ({ request }) => {
    await request.get(`${API}/events?pageSize=5`);

    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('http_server_request_duration_milliseconds_count')}`,
          );
          if (!response.ok()) return 0;
          const body = await response.json();
          return body?.data?.result?.length ?? 0;
        },
        { timeout: 90_000, intervals: [3000] },
      )
      .toBeGreaterThan(0);

    const body = await (
      await request.get(
        `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('http_server_request_duration_milliseconds_count')}`,
      )
    ).json();

    const routes: string[] = body.data.result.map(
      (series: { metric: Record<string, string> }) => series.metric.http_route,
    );

    // Route templates, never raw paths. A UUID in a label here would mean a new
    // time series per order and a Prometheus that falls over under real traffic.
    for (const route of routes) {
      expect(route, `"${route}" looks like a raw path, not a route template`).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-/i,
      );
    }
    expect(routes.some((r) => r?.includes(':'))).toBe(true);
  });
});
