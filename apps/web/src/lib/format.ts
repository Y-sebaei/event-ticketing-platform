export function formatMoney(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100);
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  }).format(new Date(iso));
}

/**
 * A stable key for one checkout attempt. Regenerated only when the customer
 * changes what they are buying, so pressing "Buy" twice — or a flaky connection
 * retrying — reaches the same order rather than two.
 */
export function idempotencyKeyFor(parts: (string | number)[]): string {
  const raw = parts.join(':');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return `web-${Math.abs(hash).toString(36)}-${raw.length}`;
}
