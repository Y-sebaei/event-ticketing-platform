import { execFileSync } from 'node:child_process';
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

/**
 * Guards the bug that loses money.
 *
 * A hold expires while the customer pays, and an expiry sweeper collects the
 * abandoned ones. But a *paid* order's reservation also sits unreleased until
 * the fulfilment consumer commits it — so if that consumer is down longer than
 * the hold TTL, a naive sweeper reclaims seats that have already been paid for
 * and puts them back on sale. The consumer then finds the reservation gone,
 * refuses to commit, and the order dead-letters: customer charged, no tickets,
 * seats resold to somebody else.
 *
 * The fix is a `confirmed` reservation state that the sweeper never touches.
 * This test proves it by doing the damaging thing deliberately: stopping the
 * consumer, paying, and waiting out the entire hold window.
 *
 * It only runs when the stack was started with a compressed TTL, because at the
 * production value of 15 minutes it would be useless in CI. It also drives
 * docker directly, which no other spec does — that is the price of testing a
 * failure that only appears when a service is down.
 */
const ttlSeconds = Number(process.env.CHECKOUT_HOLD_TTL_SECONDS ?? 0);
const enabled = ttlSeconds > 0 && ttlSeconds <= 120;

function compose(...args: string[]): void {
  execFileSync('docker', ['compose', ...args], { stdio: 'ignore' });
}

async function availabilityOf(
  request: Parameters<typeof firstAvailableTicketType>[0],
  slug: string,
  ticketTypeId: string,
): Promise<number> {
  const response = await request.get(`${API}/events/${slug}`);
  const event = await response.json();
  return event.ticketTypes.find((t: { id: string }) => t.id === ticketTypeId).quantityAvailable;
}

test.describe('a paid order survives its hold expiring', () => {
  test.skip(
    !enabled,
    'needs the stack started with a compressed CHECKOUT_HOLD_TTL_SECONDS (<= 120)',
  );

  // Stopping and restarting a service, plus waiting out the hold window.
  test.setTimeout(ttlSeconds * 1000 + 180_000);

  test.afterAll(() => {
    // Never leave the consumer down for the specs that follow.
    try {
      compose('start', 'worker');
    } catch {
      /* already running */
    }
  });

  /**
   * The control case, and it is not optional.
   *
   * The test below proves that a paid order's seats survive expiry. That result
   * is only meaningful if the sweeper is actually running: if it were dead, or
   * never scheduled, the other test would pass for entirely the wrong reason
   * and keep passing after the guard was removed. This one shows the sweeper
   * does reclaim an abandoned hold, so the other one is measuring the guard
   * rather than measuring nothing.
   */
  test('an abandoned checkout has its seats reclaimed', async ({ request }) => {
    await waitForCatalog(request);

    const quantity = 2;
    const { event, ticketType } = await firstAvailableTicketType(
      request,
      'neukoelln-noise-collective',
      quantity,
    );
    const availableBefore = ticketType.quantityAvailable;

    // Start a checkout and then walk away. No payment, ever.
    await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity,
      email: `abandoned+${Date.now()}@example.berlin`,
      idempotencyKey: `e2e-abandoned-${Date.now()}`,
    });

    const availableWhileHeld = await availabilityOf(request, event.slug, ticketType.id);
    expect(availableWhileHeld, 'the hold did not take the seats off sale').toBe(
      availableBefore - quantity,
    );

    // The seats must come back once the hold lapses, or an abandoned tab would
    // remove them from sale permanently.
    await expect
      .poll(() => availabilityOf(request, event.slug, ticketType.id), {
        timeout: ttlSeconds * 1000 + 60_000,
        intervals: [2000],
      })
      .toBe(availableBefore);
  });

  test('the sweeper never reclaims seats that were paid for', async ({ request }) => {
    await waitForCatalog(request);

    const quantity = 2;
    const { event, ticketType } = await firstAvailableTicketType(
      request,
      'ostkreuz-techno-marathon',
      quantity,
    );
    const availableBefore = ticketType.quantityAvailable;

    // 1. Take fulfilment offline so the reservation cannot be committed.
    compose('stop', 'worker');

    // 2. Buy and pay. The order reaches 'paid'; nothing can fulfil it.
    const order = await checkoutViaApi(request, {
      eventSlug: event.slug,
      ticketTypeId: ticketType.id,
      quantity,
      email: `expiry+${Date.now()}@example.berlin`,
      idempotencyKey: `e2e-expiry-${Date.now()}`,
    });
    await completePayment(request, {
      sessionId: sessionIdFrom(order.paymentUrl),
      orderId: order.orderId,
      outcome: 'succeeded',
    });
    await waitForOrderStatus(request, order, 'paid');

    // 3. Wait out the entire hold window, plus room for two sweeper passes.
    await new Promise((resolve) => setTimeout(resolve, ttlSeconds * 1000 + 40_000));

    // 4. The seats must still be gone. If the sweeper reclaimed them,
    //    availability climbs back and they are on sale to someone else.
    const afterExpiry = await request.get(`${API}/events/${event.slug}`);
    const sold = (await afterExpiry.json()).ticketTypes.find(
      (t: { id: string }) => t.id === ticketType.id,
    );
    expect(
      sold.quantityAvailable,
      'the sweeper released seats belonging to a paid order',
    ).toBe(availableBefore - quantity);

    // 5. Bring fulfilment back. The order must still complete, long after the
    //    hold it was created under would have expired.
    compose('start', 'worker');
    const fulfilled = await waitForOrderStatus(request, order, 'fulfilled');
    expect(fulfilled.tickets, 'a paid order lost its tickets to hold expiry').toHaveLength(
      quantity,
    );
  });
});
