-- Catalog: venues, events and ticket types. Owned and written only by the API.
-- Money is always an integer count of minor units; there is no NUMERIC and no
-- float anywhere in this schema.

CREATE TABLE catalog.venue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  address_line text        NOT NULL,
  city         text        NOT NULL,
  country      text        NOT NULL DEFAULT 'DE',
  latitude     double precision,
  longitude    double precision,
  capacity     integer     NOT NULL CHECK (capacity > 0),
  timezone     text        NOT NULL DEFAULT 'Europe/Berlin',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX venue_city_idx ON catalog.venue (city);

CREATE TABLE catalog.event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid        NOT NULL REFERENCES catalog.venue (id) ON DELETE RESTRICT,
  slug            text        NOT NULL UNIQUE,
  title           text        NOT NULL,
  description     text        NOT NULL DEFAULT '',
  starts_at       timestamptz NOT NULL,
  doors_at        timestamptz,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'published', 'cancelled')),
  -- Basis points, so the service fee stays an integer and pricing never sees a
  -- float. 750 = 7.5%.
  service_fee_bps integer     NOT NULL DEFAULT 750 CHECK (service_fee_bps BETWEEN 0 AND 10000),
  currency        char(3)     NOT NULL DEFAULT 'EUR',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (doors_at IS NULL OR doors_at <= starts_at)
);

CREATE INDEX event_starts_at_idx ON catalog.event (starts_at);
CREATE INDEX event_status_starts_at_idx ON catalog.event (status, starts_at);
CREATE INDEX event_venue_idx ON catalog.event (venue_id);

CREATE TABLE catalog.ticket_type (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid        NOT NULL REFERENCES catalog.event (id) ON DELETE CASCADE,
  name           text        NOT NULL,
  price_cents    integer     NOT NULL CHECK (price_cents >= 0),
  quantity_total integer     NOT NULL CHECK (quantity_total > 0),
  max_per_order  integer     NOT NULL DEFAULT 6 CHECK (max_per_order BETWEEN 1 AND 10),
  sales_start_at timestamptz NOT NULL,
  sales_end_at   timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, name),
  CHECK (sales_start_at < sales_end_at)
);

CREATE INDEX ticket_type_event_idx ON catalog.ticket_type (event_id);
