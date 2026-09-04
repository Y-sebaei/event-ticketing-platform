import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, canTransition, isExpiredOrder, isTerminal, transition } from '../src';

describe('order state machine', () => {
  it('walks the happy path pending -> paid -> fulfilled', () => {
    expect(transition('pending', 'paid')).toEqual({ status: 'paid', changed: true });
    expect(transition('paid', 'fulfilled')).toEqual({ status: 'fulfilled', changed: true });
  });

  it('treats a repeated transition as a no-op so replays are safe', () => {
    expect(transition('paid', 'paid')).toEqual({ status: 'paid', changed: false });
    expect(transition('fulfilled', 'fulfilled')).toEqual({ status: 'fulfilled', changed: false });
  });

  it('never lets a fulfilled order be paid again', () => {
    expect(() => transition('fulfilled', 'paid')).toThrow(IllegalTransitionError);
  });

  it('never resurrects a failed or expired order', () => {
    expect(() => transition('failed', 'paid')).toThrow(IllegalTransitionError);
    expect(() => transition('expired', 'paid')).toThrow(IllegalTransitionError);
  });

  it('cannot skip straight from pending to fulfilled', () => {
    expect(canTransition('pending', 'fulfilled')).toBe(false);
    expect(() => transition('pending', 'fulfilled')).toThrow(IllegalTransitionError);
  });

  it('knows which states are terminal', () => {
    expect(isTerminal('fulfilled')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('paid')).toBe(false);
  });
});

describe('isExpiredOrder', () => {
  const expiresAt = new Date('2026-03-01T12:15:00.000Z');

  it('expires a pending order once its hold window closes', () => {
    expect(isExpiredOrder('pending', expiresAt, new Date('2026-03-01T12:14:59.999Z'))).toBe(false);
    expect(isExpiredOrder('pending', expiresAt, expiresAt)).toBe(true);
  });

  it('never expires an order that has already been paid', () => {
    expect(isExpiredOrder('paid', expiresAt, new Date('2026-03-01T23:00:00.000Z'))).toBe(false);
  });
});
