import { expect, test } from '@playwright/test';
import {
  API,
  checkoutViaApi,
  completePayment,
  firstAvailableTicketType,
  sessionIdFrom,
  waitForCatalog,
  waitForOrderStatus,
} from './helpers';

test.describe('checkout', () => {
  test.beforeEach(async ({ request }) => {
    await waitForCatalog(request);
  });

  test('browse to event to checkout to payment to confirmation with tickets', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('Search events, artists, venues…').fill('Ambient');
    await page.getByTestId('event-card').first().click();

    await expect(page.getByTestId('ticket-type').first()).toBeVisible();
    await page.locator('[data-testid^="quantity-"]').first().selectOption('2');

    await page.getByTestId('name').fill('Ada Lovelace');
    await page.getByTestId('email').fill(`ada+${Date.now()}@example.berlin`);
    await page.getByTestId('checkout').click();

    // The built-in payment page stands in for Stripe Checkout when no key is set.
    await expect(page.getByTestId('pay-success')).toBeVisible();
    await page.getByTestId('pay-success').click();

    await expect(page.getByTestId('order-status')).toBeVisible();
    // Fulfilment is asynchronous: the page shows 'pending' first and flips once
    // the Kafka consumer has issued the tickets.
    await expect(page.getByTestId('order-status')).toHaveText('fulfilled', { timeout: 45_000 });
    await expect(page.getByTestId('ticket-serial')).toHaveCount(2);
  });

  test('a declined card releases the seats and never issues a ticket', async ({ request }) => {
    const { event, ticketType } = await firstAvailableTicketType(request, 'ostkreuz-techno-marathon', 2);
    const before = ticketType.quantityAvailable;

    const order = await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity: 2,
      email: `declined+${Date.now()}@example.berlin`,
      idempotencyKey: `e2e-declined-${Date.now()}`,
    });

    await completePayment(request, {
      sessionId: sessionIdFrom(order.paymentUrl),
      orderId: order.orderId,
      outcome: 'failed',
    });

    const final = await waitForOrderStatus(request, order, 'failed');
    expect(final.tickets).toHaveLength(0);

    // The hold has to come back, or declined cards would slowly eat the venue.
    await expect
      .poll(async () => {
        const after = await firstAvailableTicketType(request, event.slug);
        return after.ticketType.quantityAvailable;
      })
      .toBe(before);
  });

  test('a replayed webhook does not issue a second set of tickets', async ({ request }) => {
    const { event, ticketType } = await firstAvailableTicketType(request, 'nachtprogramm-late-opening', 3);

    const order = await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity: 3,
      email: `replay+${Date.now()}@example.berlin`,
      idempotencyKey: `e2e-replay-${Date.now()}`,
    });

    const sessionId = sessionIdFrom(order.paymentUrl);
    await completePayment(request, { sessionId, orderId: order.orderId, outcome: 'succeeded' });
    const fulfilled = await waitForOrderStatus(request, order, 'fulfilled');
    expect(fulfilled.tickets).toHaveLength(3);

    // Deliver the same outcome twice more, the way a provider retrying an
    // unacknowledged webhook would.
    await completePayment(request, { sessionId, orderId: order.orderId, outcome: 'succeeded' });
    await completePayment(request, { sessionId, orderId: order.orderId, outcome: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const after = await (
      await request.get(`${API}/orders/${order.orderId}?token=${order.accessToken}`)
    ).json();
    expect(after.tickets, 'a replayed webhook issued duplicate tickets').toHaveLength(3);
    expect(after.status).toBe('fulfilled');
  });

  test('a retried checkout with the same idempotency key returns the same order', async ({ request }) => {
    const { event, ticketType } = await firstAvailableTicketType(request, 'tempelhof-electronic-night');
    const key = `e2e-idem-${Date.now()}`;
    const email = `idem+${Date.now()}@example.berlin`;

    const first = await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity: 1,
      email,
      idempotencyKey: key,
    });
    const second = await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity: 1,
      email,
      idempotencyKey: key,
    });

    expect(second.orderId).toBe(first.orderId);
  });

  test('the API refuses more tickets than the per-order limit', async ({ request }) => {
    const { event, ticketType } = await firstAvailableTicketType(request, 'sold-out-showcase');

    const response = await request.post(`${API}/checkout`, {
      headers: { 'idempotency-key': `e2e-oversell-${Date.now()}` },
      data: {
        eventSlug: event.slug,
        customer: { email: `oversell+${Date.now()}@example.berlin`, name: 'Too Greedy' },
        items: [{ ticketTypeId: ticketType.id, quantity: ticketType.maxPerOrder + 5 }],
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(['INVALID_QUANTITY', 'ORDER_TOO_LARGE']).toContain(body.error);
    expect(body.traceId, 'every error response should carry a trace id').toBeTruthy();
  });

  test('an unverified webhook is rejected before it can touch an order', async ({ request }) => {
    const response = await request.post(`${API}/webhooks/payments`, {
      headers: { 'x-payment-signature': 't=1,v1=deadbeef' },
      data: { id: 'evt_forged', type: 'payment.succeeded', sessionId: 'cs_local_forged' },
    });
    expect(response.status()).toBe(400);
  });
});
