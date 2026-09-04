-- Inventory: the only schema the inventory service may touch, and the only
-- schema the inventory service is granted rights on (see infra/postgres/init.sql).

CREATE TABLE inventory.ticket_type_inventory (
  ticket_type_id    uuid PRIMARY KEY,
  event_id          uuid        NOT NULL,
  quantity_total    integer     NOT NULL CHECK (quantity_total >= 0),
  quantity_reserved integer     NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  quantity_sold     integer     NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  version           integer     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Overselling is a database error, not a race the application hopes to win.
  -- Every code path that decrements inventory runs under SELECT ... FOR UPDATE,
  -- and this constraint is what catches the path someone adds later and forgets
  -- to lock.
  CONSTRAINT inventory_not_oversold
    CHECK (quantity_reserved + quantity_sold <= quantity_total)
);

CREATE INDEX ticket_type_inventory_event_idx ON inventory.ticket_type_inventory (event_id);

CREATE TABLE inventory.reservation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid        NOT NULL,
  ticket_type_id uuid        NOT NULL REFERENCES inventory.ticket_type_inventory (ticket_type_id),
  quantity       integer     NOT NULL CHECK (quantity > 0),
  state          text        NOT NULL DEFAULT 'held'
                             CHECK (state IN ('held', 'committed', 'released')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One reservation per (order, ticket type). This is what makes Hold
  -- idempotent: a retried hold hits this constraint and is recognised as the
  -- same request rather than doubling the customer's seats.
  UNIQUE (order_id, ticket_type_id)
);

CREATE INDEX reservation_order_idx ON inventory.reservation (order_id);
-- Drives the expiry sweeper; partial so it only indexes what the sweeper reads.
CREATE INDEX reservation_expiry_idx ON inventory.reservation (expires_at) WHERE state = 'held';

-- Append-only. Every change to a counter writes a row here, which turns
-- "prove you did not double-decrement" from an argument into a SQL query:
--   SELECT ref_id, count(*) FROM inventory.ledger
--   WHERE reason = 'commit' GROUP BY ref_id HAVING count(*) > 1;
CREATE TABLE inventory.ledger (
  id             bigserial PRIMARY KEY,
  ticket_type_id uuid        NOT NULL,
  delta_reserved integer     NOT NULL DEFAULT 0,
  delta_sold     integer     NOT NULL DEFAULT 0,
  reason         text        NOT NULL CHECK (reason IN ('register','hold','commit','release','expire')),
  ref_id         text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_ref_idx ON inventory.ledger (ref_id);
CREATE INDEX ledger_ticket_type_idx ON inventory.ledger (ticket_type_id, created_at DESC);

-- The inventory service publishes `inventory.changed` through its own outbox,
-- for the same reason the API does: the counter change and the announcement of
-- it commit together or not at all.
CREATE TABLE inventory.outbox (
  id             bigserial PRIMARY KEY,
  aggregate_type text        NOT NULL,
  aggregate_id   text        NOT NULL,
  topic          text        NOT NULL,
  message_key    text        NOT NULL,
  message_id     text        NOT NULL UNIQUE,
  payload        jsonb       NOT NULL,
  trace_context  jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text
);

CREATE INDEX inventory_outbox_unpublished_idx ON inventory.outbox (id) WHERE published_at IS NULL;
