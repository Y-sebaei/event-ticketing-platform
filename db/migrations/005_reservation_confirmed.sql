-- Adds a 'confirmed' reservation state, between 'held' and 'committed'.
--
-- Without it there is a window that loses money. A hold expires 15 minutes
-- after checkout, but a paid order's reservation stays 'held' until the
-- fulfilment consumer commits it. If that consumer is down longer than the TTL,
-- the expiry sweeper releases seats belonging to an order that has already been
-- paid for — and resells them. When the consumer recovers, Commit finds the
-- reservation released, refuses it, and the order dead-letters: the customer is
-- charged, receives nothing, and their seats now belong to someone else.
--
-- 'confirmed' means "payment succeeded, awaiting fulfilment". The sweeper only
-- collects 'held', so a confirmed reservation is never reclaimed no matter how
-- long fulfilment takes.
ALTER TABLE inventory.reservation DROP CONSTRAINT reservation_state_check;

ALTER TABLE inventory.reservation
  ADD CONSTRAINT reservation_state_check
  CHECK (state IN ('held', 'confirmed', 'committed', 'released'));
