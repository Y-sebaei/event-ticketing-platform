import { describe, expect, it } from 'vitest';
import { formatCents, isCents, roundHalfUp } from '../src';

describe('isCents', () => {
  it('accepts whole non-negative amounts', () => {
    expect(isCents(0)).toBe(true);
    expect(isCents(1999)).toBe(true);
  });

  it.each([-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined])(
    'rejects %p, which is not a whole number of minor units',
    (value) => {
      expect(isCents(value)).toBe(false);
    },
  );

  it('rejects an integer too large to be represented exactly', () => {
    expect(isCents(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });
});

describe('roundHalfUp', () => {
  it('rounds a half upwards rather than to even', () => {
    // Math.round agrees here, but banker's rounding would give 2.
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(3.5)).toBe(4);
  });

  it('rounds below a half downwards', () => {
    expect(roundHalfUp(2.49)).toBe(2);
  });

  it('rounds away from zero for negatives, not towards it', () => {
    // The reason this exists rather than a bare Math.round, which gives -2.
    expect(roundHalfUp(-2.5)).toBe(-3);
  });

  it('leaves whole numbers alone', () => {
    expect(roundHalfUp(7)).toBe(7);
    expect(roundHalfUp(0)).toBe(0);
  });
});

describe('formatCents', () => {
  it('renders minor units as euros in German convention', () => {
    const formatted = formatCents(1800);
    // Comma as the decimal separator, and the symbol trailing.
    expect(formatted).toContain('18,00');
    expect(formatted).toContain('€');
  });

  it('always shows two decimal places', () => {
    expect(formatCents(500)).toContain('5,00');
    expect(formatCents(0)).toContain('0,00');
  });

  it('groups thousands', () => {
    expect(formatCents(1234567)).toContain('12.345,67');
  });
});
