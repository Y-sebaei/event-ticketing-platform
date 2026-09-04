import { expect, test } from '@playwright/test';
import { API, waitForCatalog } from './helpers';

test.describe('browse and search', () => {
  test.beforeEach(async ({ request }) => {
    await waitForCatalog(request);
  });

  test('the catalog is never empty on first load', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('event-card').first()).toBeVisible();
    expect(await page.getByTestId('event-card').count()).toBeGreaterThan(3);
  });

  test('full-text search narrows the results to matching events', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('event-card').first()).toBeVisible();

    await page.getByPlaceholder('Search events, artists, venues…').fill('jazz');

    await expect(page.getByTestId('event-card')).toHaveCount(1);
    await expect(page.getByTestId('event-card').first()).toContainText('Jazz');
  });

  test('search matches on the venue name, not only the title', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('Search events, artists, venues…').fill('Berghain');
    await expect(page.getByTestId('event-card').first()).toBeVisible();
    await expect(page.getByTestId('event-card').first()).toContainText('Klubnacht');
  });

  test('a search with no matches says so instead of showing everything', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('Search events, artists, venues…').fill('zzzzznotanevent');
    await expect(page.getByTestId('no-results')).toBeVisible();
  });

  test('the city filter excludes other cities', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('event-card').first()).toBeVisible();

    await page.getByLabel('City').selectOption('Hamburg');
    await expect(page.getByTestId('event-card')).toHaveCount(1);
    await expect(page.getByTestId('event-card').first()).toContainText('Hamburg Transfer');
  });

  test('pagination returns different events per page and an honest total', async ({ request }) => {
    const first = await (await request.get(`${API}/events?pageSize=3&page=1&sort=date`)).json();
    const second = await (await request.get(`${API}/events?pageSize=3&page=2&sort=date`)).json();

    expect(first.items).toHaveLength(3);
    expect(second.items.length).toBeGreaterThan(0);
    expect(first.total).toBe(second.total);
    expect(first.totalPages).toBe(Math.ceil(first.total / 3));

    const firstIds = new Set(first.items.map((i: { eventId: string }) => i.eventId));
    for (const item of second.items) {
      expect(firstIds.has(item.eventId), 'page 2 repeated an event from page 1').toBe(false);
    }
  });

  test('a price filter only returns events with something in range', async ({ request }) => {
    const response = await request.get(`${API}/events?maxPriceCents=2000&pageSize=50`);
    const body = await response.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.minPriceCents).toBeLessThanOrEqual(2000);
    }
  });

  test('results are served by Elasticsearch, not the database fallback', async ({ request }) => {
    const body = await (await request.get(`${API}/events?q=techno`)).json();
    // If this ever reads 'database' in CI, indexing broke and the fallback is
    // quietly covering for it — which is exactly what we want to catch.
    expect(body.source).toBe('search');
  });
});
