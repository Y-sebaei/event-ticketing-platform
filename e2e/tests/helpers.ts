import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://localhost:3000';

/** Waits for the seeded catalog to be searchable before a test depends on it. */
export async function waitForCatalog(request: APIRequestContext, minimum = 5): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${API}/events?pageSize=50`);
        if (!response.ok()) return 0;
        const body = await response.json();
        return body.total as number;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(minimum);
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

export async function firstAvailableTicketType(request: APIRequestContext, slug: string) {
  const response = await request.get(`${API}/events/${slug}`);
  expect(response.ok()).toBeTruthy();
  const event = await response.json();
  const ticketType = event.ticketTypes.find(
    (t: { quantityAvailable: number }) => t.quantityAvailable > 0,
  );
  expect(ticketType, `no availability left for ${slug}`).toBeTruthy();
  return { event, ticketType };
}

export async function dismissIfNeeded(_page: Page): Promise<void> {
  // Placeholder for a consent banner, which this app deliberately does not have.
}
