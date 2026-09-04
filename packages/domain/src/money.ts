/**
 * Money is always an integer count of minor units (cents). There is no float in
 * this codebase, and nothing here ever produces a fractional cent — the one
 * place rounding is unavoidable is the percentage service fee, and that has a
 * single, named, tested rounding rule.
 */
export type Cents = number;

export const SUPPORTED_CURRENCIES = ['EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Half-up rounding, which is what a customer expects from a fee line and what
 * accounting reconciles against. `Math.round` is deliberately not used directly
 * because it rounds -0.5 towards zero; fees are non-negative here, but stating
 * the rule once keeps it from drifting if that ever changes.
 */
export function roundHalfUp(value: number): Cents {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function formatCents(amount: Cents, currency: Currency = 'EUR'): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount / 100);
}
