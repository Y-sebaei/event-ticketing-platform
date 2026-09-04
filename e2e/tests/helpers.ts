import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://localhost:3000';

/**
 * Waits for the seeded catalog to be genuinely searchable.
 *
 * Waiting for rows to exist is not enough, and the difference is a real source
 * of flakes on a cold start. Seeding writes to Postgres and only then indexes
 * asynchronously through the outbox, and in that window the API serves results
 * from its database fallback — which satisfies "there are nine events" while
 * `source` is still 'database'. A test asserting that Elasticsearch is doing
 * the work would then fail on a cold CI runner and pass on a warm laptop.
 *
 * So the precondition is both: the events are there, and search is answering.
 */
export async function waitForCatalog(request: APIRequestContext, minimum = 5): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${API}/events?pageSize=50`);
        if (!response.ok()) return 'unreachable';
        const body = await response.json();
        return (body.total as number) >= minimum ? (body.source as string) : `only ${body.total}`;
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .toBe('search');
}

export interface CheckoutResponse {
  orderId: string;
  accessToken: string;
  paymentUrl: string;
  totalCents: number;
  traceId?: string;
}

/** Buys through the API, bypassing the UI, for tests about the pipeline. */
export async function checkoutViaApi(
  request: APIRequestContext,
  input: {
    eventSlug: string;
    ticketTypeId: string;
    quantity: number;
    email: string;
    idempotencyKey: string;
  },
): Promise<CheckoutResponse> {
  const response = await request.post(`${API}/checkout`, {
    headers: { 'idempotency-key': input.idempotencyKey },
    data: {
      eventSlug: input.eventSlug,
      customer: { email: input.email, name: 'E2E Buyer' },
      items: [{ ticketTypeId: input.ticketTypeId, quantity: input.quantity }],
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

export function sessionIdFrom(paymentUrl: string): string {
  const url = new URL(paymentUrl, 'http://localhost');
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    throw new Error(
      'No local payment session in the checkout URL. These tests target the local gateway; ' +
        'unset STRIPE_SECRET_KEY to run them, or drive Stripe Checkout in the browser instead.',
    );
  }
  return sessionId;
}

export async function completePayment(
  request: APIRequestContext,
  input: { sessionId: string; orderId: string; outcome: 'succeeded' | 'failed' },
): Promise<void> {
  const response = await request.post(`${API}/payments/local/complete`, { data: input });
  expect(response.ok(), await response.text()).toBeTruthy();
}

export async function waitForOrderStatus(
  request: APIRequestContext,
  order: { orderId: string; accessToken: string },
  status: string,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${API}/orders/${order.orderId}?token=${order.accessToken}`,
        );
        if (!response.ok()) return 'unreachable';
        body = await response.json();
        return body.status as string;
      },
      { timeout: 45_000, intervals: [500] },
    )
    .toBe(status);
  return body;
}

/**
 * Picks a ticket type that can actually satisfy `quantity`.
 *
 * Both the remaining stock and the per-order limit have to be checked. The API
 * returns ticket types cheapest first, and the cheapest tier is often the one
 * with the tightest maxPerOrder — so "the first one with stock" quietly picks a
 * fixture that rejects the purchase the test is trying to make.
 */
export async function firstAvailableTicketType(
  request: APIRequestContext,
  slug: string,
  quantity = 1,
) {
  const response = await request.get(`${API}/events/${slug}`);
  expect(response.ok()).toBeTruthy();
  const event = await response.json();
  const ticketType = event.ticketTypes.find(
    (t: { quantityAvailable: number; maxPerOrder: number }) =>
      t.quantityAvailable >= quantity && t.maxPerOrder >= quantity,
  );
  expect(ticketType, `no ticket type for ${slug} can sell ${quantity} at once`).toBeTruthy();
  return { event, ticketType };
}

export async function dismissIfNeeded(_page: Page): Promise<void> {
  // Placeholder for a consent banner, which this app deliberately does not have.
}
