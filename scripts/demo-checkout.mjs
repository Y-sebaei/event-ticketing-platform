#!/usr/bin/env node
/**
 * Drives one complete purchase and prints the Grafana link for its trace.
 *
 * This is the second of the three commands in the README's "See a distributed
 * trace" section. It buys a ticket, waits for fulfilment, and hands back a URL
 * showing a single trace that runs HTTP -> Postgres -> gRPC -> payment webhook
 * -> Kafka -> consumer -> gRPC -> Postgres, across three processes.
 */
const API = process.env.API_URL ?? 'http://localhost:3000';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3001';
const SLUG = process.env.DEMO_EVENT_SLUG ?? 'kreuzberg-jazz-sessions';

const log = (...args) => console.log('[demo]', ...args);

async function json(path, init) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

function traceUrl(traceId) {
  const left = encodeURIComponent(JSON.stringify({ datasource: 'tempo', queries: [{ query: traceId, queryType: 'traceql' }] }));
  return `${GRAFANA}/explore?panes={"a":${left}}&schemaVersion=1&orgId=1`;
}

const event = await json(`/events/${SLUG}`);
const ticketType = event.ticketTypes.find((t) => t.quantityAvailable > 0);
if (!ticketType) throw new Error(`every ticket type for ${SLUG} is sold out`);

log(`buying 2 x "${ticketType.name}" for ${event.title}`);

const checkout = await json('/checkout', {
  method: 'POST',
  headers: { 'idempotency-key': `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` },
  body: JSON.stringify({
    eventSlug: SLUG,
    customer: { email: 'demo@example.berlin', name: 'Demo Reviewer' },
    items: [{ ticketTypeId: ticketType.id, quantity: 2 }],
  }),
});

log(`order ${checkout.orderId} created, trace ${checkout.traceId ?? 'n/a'}`);

// With Stripe configured the payment happens in a browser, so the demo stops
// at the checkout URL. Without it, the local gateway lets us complete the
// purchase headlessly and show the full trace including fulfilment.
const sessionId = new URL(checkout.paymentUrl, 'http://localhost').searchParams.get('session');

if (!sessionId) {
  log('Stripe is configured — open this to finish paying:');
  log(checkout.paymentUrl);
  log('Trace so far:', traceUrl(checkout.traceId));
  process.exit(0);
}

await json('/payments/local/complete', {
  method: 'POST',
  body: JSON.stringify({ sessionId, orderId: checkout.orderId, outcome: 'succeeded' }),
});
log('payment webhook delivered and verified');

let order;
for (let attempt = 1; attempt <= 40; attempt++) {
  order = await json(`/orders/${checkout.orderId}?token=${checkout.accessToken}`);
  if (order.status === 'fulfilled') break;
  await new Promise((r) => setTimeout(r, 500));
}

if (order?.status !== 'fulfilled') {
  log(`order is still ${order?.status}; check "docker compose logs worker"`);
  process.exit(1);
}

log(`fulfilled — ${order.tickets.length} tickets: ${order.tickets.map((t) => t.serial).join(', ')}`);
console.log('');
console.log('  Distributed trace (HTTP -> gRPC -> Kafka -> consumer):');
console.log(`  ${traceUrl(checkout.traceId)}`);
console.log('');
console.log(`  Dashboard:      ${GRAFANA}/d/ticketing-red/ticketing-red-metrics`);
console.log(`  Confirmation:   ${process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173'}/orders/${checkout.orderId}?token=${checkout.accessToken}`);
console.log(`  Email:          http://localhost:8025`);
