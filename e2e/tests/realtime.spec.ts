import { expect, test } from '@playwright/test';
import { checkoutViaApi, firstAvailableTicketType, waitForCatalog } from './helpers';

/**
 * The realtime requirement, tested the way it was described: two browsers on
 * the same event page watch the same number drop at the same moment.
 *
 * Neither page reloads and neither polls. The drop travels from the inventory
 * service's outbox, through Kafka, into the API's fan-out consumer, out over
 * both WebSocket connections.
 */
test.describe('realtime inventory', () => {
  test.beforeEach(async ({ request }) => {
    await waitForCatalog(request);
  });

  test('two browsers watching one event see the count drop together', async ({ browser, request }) => {
    const slug = 'kreuzberg-jazz-sessions';
    const { ticketType } = await firstAvailableTicketType(request, slug, 3);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await Promise.all([pageA.goto(`/events/${slug}`), pageB.goto(`/events/${slug}`)]);

    const counterA = pageA.getByTestId(`remaining-${ticketType.id}`);
    const counterB = pageB.getByTestId(`remaining-${ticketType.id}`);
    await expect(counterA).toContainText(String(ticketType.quantityAvailable));
    await expect(counterB).toContainText(String(ticketType.quantityAvailable));

    // A third party buys. Neither open page did anything.
    const bought = 3;
    await checkoutViaApi(request, {
      eventSlug: slug,
      ticketTypeId: ticketType.id,
      quantity: bought,
      email: `realtime+${Date.now()}@example.berlin`,
      idempotencyKey: `e2e-realtime-${Date.now()}`,
    });

    const expected = String(ticketType.quantityAvailable - bought);
    await expect(counterA).toContainText(expected, { timeout: 20_000 });
    await expect(counterB).toContainText(expected, { timeout: 20_000 });

    await contextA.close();
    await contextB.close();
  });
});
