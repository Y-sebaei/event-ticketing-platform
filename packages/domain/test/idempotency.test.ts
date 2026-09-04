import { describe, expect, it } from 'vitest';
import {
  InvalidIdempotencyKeyError,
  assertValidIdempotencyKey,
  checkoutFingerprint,
  messageDedupeKey,
  resolveIdempotencyKey,
  ticketSerial,
} from '../src';

describe('checkoutFingerprint', () => {
  const base = {
    customerEmail: 'anna@example.com',
    eventId: 'evt_1',
    lines: [
      { ticketTypeId: 'tt_a', quantity: 2 },
      { ticketTypeId: 'tt_b', quantity: 1 },
    ],
  };

  it('is stable for the same purchase', () => {
    expect(checkoutFingerprint(base)).toBe(checkoutFingerprint(base));
  });

  it('ignores line ordering, so a reordered retry is still the same order', () => {
    const reordered = { ...base, lines: [...base.lines].reverse() };
    expect(checkoutFingerprint(reordered)).toBe(checkoutFingerprint(base));
  });

  it('ignores email casing and surrounding whitespace', () => {
    expect(checkoutFingerprint({ ...base, customerEmail: '  Anna@Example.COM ' })).toBe(
      checkoutFingerprint(base),
    );
  });

  it('changes when the quantity changes', () => {
    const different = { ...base, lines: [{ ticketTypeId: 'tt_a', quantity: 3 }, base.lines[1]!] };
    expect(checkoutFingerprint(different)).not.toBe(checkoutFingerprint(base));
  });

  it('changes when the event changes', () => {
    expect(checkoutFingerprint({ ...base, eventId: 'evt_2' })).not.toBe(checkoutFingerprint(base));
  });

  it('changes for a different customer', () => {
    expect(checkoutFingerprint({ ...base, customerEmail: 'ben@example.com' })).not.toBe(
      checkoutFingerprint(base),
    );
  });
});

describe('assertValidIdempotencyKey', () => {
  it('accepts a realistic client key', () => {
    expect(assertValidIdempotencyKey('checkout-2026-03-01-7f3a9c2b')).toBe(
      'checkout-2026-03-01-7f3a9c2b',
    );
  });

  it.each(['short', '', 'has spaces in it', 'contains/slash', 'a'.repeat(256)])(
    'rejects %j',
    (key) => {
      expect(() => assertValidIdempotencyKey(key)).toThrow(InvalidIdempotencyKeyError);
    },
  );

  it('accepts a generated fingerprint as a valid key', () => {
    const fp = checkoutFingerprint({ customerEmail: 'a@b.de', eventId: 'e', lines: [] });
    expect(assertValidIdempotencyKey(fp)).toBe(fp);
  });
});

describe('resolveIdempotencyKey', () => {
  const input = { customerEmail: 'a@b.de', eventId: 'evt_1', lines: [{ ticketTypeId: 't', quantity: 1 }] };

  it('falls back to the content fingerprint when the client sends nothing', () => {
    expect(resolveIdempotencyKey(undefined, input)).toBe(checkoutFingerprint(input));
    expect(resolveIdempotencyKey(null, input)).toBe(checkoutFingerprint(input));
    expect(resolveIdempotencyKey('', input)).toBe(checkoutFingerprint(input));
  });

  it('prefers an explicit client key, letting the client define the boundary', () => {
    expect(resolveIdempotencyKey('client-supplied-key-1', input)).toBe('client-supplied-key-1');
  });
});

describe('messageDedupeKey', () => {
  it('scopes dedupe to the consumer group', () => {
    expect(messageDedupeKey('fulfilment', 'msg-1')).toBe('fulfilment:msg-1');
    expect(messageDedupeKey('search-indexer', 'msg-1')).not.toBe(messageDedupeKey('fulfilment', 'msg-1'));
  });

  it('rejects an incomplete key', () => {
    expect(() => messageDedupeKey('', 'msg-1')).toThrow(InvalidIdempotencyKeyError);
    expect(() => messageDedupeKey('fulfilment', '')).toThrow(InvalidIdempotencyKeyError);
  });
});

describe('ticketSerial', () => {
  it('is deterministic, so a redelivered fulfilment mints the same serial', () => {
    expect(ticketSerial('ord_1', 'tt_a', 1)).toBe(ticketSerial('ord_1', 'tt_a', 1));
  });

  it('differs per seat, order and ticket type', () => {
    const a = ticketSerial('ord_1', 'tt_a', 1);
    expect(a).not.toBe(ticketSerial('ord_1', 'tt_a', 2));
    expect(a).not.toBe(ticketSerial('ord_2', 'tt_a', 1));
    expect(a).not.toBe(ticketSerial('ord_1', 'tt_b', 1));
  });

  it('looks like a ticket serial', () => {
    expect(ticketSerial('ord_1', 'tt_a', 1)).toMatch(/^TIX-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('rejects a seat number that is not a positive integer', () => {
    expect(() => ticketSerial('ord_1', 'tt_a', 0)).toThrow(InvalidIdempotencyKeyError);
  });
});
