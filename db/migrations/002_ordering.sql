-- Ordering: customers, orders, tickets, and the three idempotency guards.
-- Written by the API (checkout, webhooks) and by the worker (fulfilment).
--
-- The table is `customer_order` rather than `order` because ORDER is a reserved
-- word and quoting it in every query is a papercut with no upside.

CREATE TABLE ordering.customer (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text        NOT NULL,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without requiring the citext extension.
CREATE UNIQUE INDEX customer_email_lower_idx ON ordering.customer (lower(email));

CREATE TABLE ordering.customer_order (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid        NOT NULL REFERENCES ordering.customer (id),
  event_id              uuid        NOT NULL,
  status                text        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','paid','fulfilled','failed','expired')),
  subtotal_cents        integer     NOT NULL CHECK (subtotal_cents >= 0),
  fee_cents             integer     NOT NULL CHECK (fee_cents >= 0),
  total_cents           integer     NOT NULL CHECK (total_cents >= 0),
  currency              char(3)     NOT NULL DEFAULT 'EUR',
  -- Guard 1: the browser double-submitting checkout.
  idempotency_key       text        NOT NULL UNIQUE,
  payment_session_id    text        UNIQUE,
  payment_session_url   text,
  payment_intent_id     text,
  payment_status_detail text,
  -- The confirmation page is reachable with this token instead of a login.
  access_token          text        NOT NULL UNIQUE,
  expires_at            timestamptz NOT NULL,
  paid_at               timestamptz,
  fulfilled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_order_status_expires_idx ON ordering.customer_order (status, expires_at);
CREATE INDEX customer_order_customer_idx ON ordering.customer_order (customer_id);

CREATE TABLE ordering.order_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid    NOT NULL REFERENCES ordering.customer_order (id) ON DELETE CASCADE,
  ticket_type_id   uuid    NOT NULL,
  -- Names and prices are snapshotted: an order must still render correctly
  -- after the catalog changes underneath it.
  name_snapshot    text    NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  UNIQUE (order_id, ticket_type_id)
);

-- One row per issued ticket. `(order_id, ticket_type_id, seq)` is unique, so a
-- redelivered fulfilment message cannot mint a second set of tickets even if
-- every guard above it were removed. This constraint is the backstop the whole
-- idempotency story rests on.
CREATE TABLE ordering.ticket (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid        NOT NULL REFERENCES ordering.customer_order (id) ON DELETE CASCADE,
  ticket_type_id uuid        NOT NULL,
  seq            integer     NOT NULL CHECK (seq > 0),
  serial         text        NOT NULL UNIQUE,
  qr_token       text        NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, ticket_type_id, seq)
);

CREATE INDEX ticket_order_idx ON ordering.ticket (order_id);

-- Guard 2: the payment provider replaying a webhook. Stripe retries for days;
-- the primary key makes every delivery after the first a no-op.
CREATE TABLE ordering.webhook_event (
  provider_event_id text PRIMARY KEY,
  provider          text        NOT NULL DEFAULT 'stripe',
  type              text        NOT NULL,
  payload           jsonb       NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  handled_at        timestamptz,
  error             text
);

-- Guard 3: Kafka redelivering after a consumer crash. Keyed by consumer group,
-- so two different consumers may both process a message and the same one may
-- not.
CREATE TABLE ordering.processed_message (
  consumer_group text        NOT NULL,
  message_id     text        NOT NULL,
  topic          text        NOT NULL,
  processed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_group, message_id)
);

-- Transactional outbox. Written in the same transaction as the state change it
-- describes, so "order marked paid" and "order.paid will be published" either
-- both happen or neither does. `trace_context` carries the W3C traceparent so
-- the consumer's spans join the checkout's trace.
CREATE TABLE ordering.outbox (
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

-- Partial index: the relay only ever asks for unpublished rows, so this keeps
-- that query proportional to the backlog rather than to every order ever placed.
CREATE INDEX outbox_unpublished_idx ON ordering.outbox (id) WHERE published_at IS NULL;
