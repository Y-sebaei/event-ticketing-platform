# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written for someone who has never seen this repository: they say what changed
and, where it is not obvious, why.

## [0.1.0] — 2026-09-04

The first working version. Everything below landed together as the initial build, so this
entry is longer than a release note normally would be.

### Added

**The platform**

- A ticketing domain: venues host events, events sell ticket types with finite inventory,
  and customers buy through a checkout. No admin portal, no reviews, no recommendations —
  the scope was kept small on purpose so that each remaining piece could be built properly.
- Three backend services. `api` serves the public REST API and the WebSocket gateway;
  `inventory` speaks gRPC only and is the sole writer of stock; `worker` runs the Kafka
  consumers. A Vue 3 single-page app sits in front of them.
- One `docker compose up` starts everything, including Kafka, Elasticsearch, Prometheus,
  Tempo and Grafana. There is no second setup step.
- A seed script that loads nine events across real Berlin venues, so the application is
  never empty on a first run. It goes through the public API rather than straight into the
  database, so seeding also proves the creation pipeline works.

**Observability**

- OpenTelemetry across all three services, loaded via `node --require` so instrumentation
  is registered before any application module is imported.
- Distributed traces spanning HTTP handler → PostgreSQL → gRPC → payment webhook → Kafka →
  consumer → gRPC → PostgreSQL. Trace context is captured when a message is written to the
  outbox and restored by the consumer, so the asynchronous half of a checkout belongs to
  the same trace as the request that started it.
- RED metrics per endpoint from a single histogram, labelled by route template rather than
  raw path, so cardinality stays bounded.
- Additional signals for the parts that fail quietly: outbox backlog, Kafka consumption by
  outcome, gRPC latency, idempotency suppressions, search index failures, live socket
  count.
- A Grafana dashboard committed as JSON and provisioned on startup, together with the
  Prometheus and Tempo datasources. Nothing has to be clicked into existence.
- `npm run demo:checkout` drives a complete purchase and prints a link to its trace. This
  is the third of the three commands in the README's "See a distributed trace" section.

**Payments**

- Stripe Checkout Sessions in test mode, a webhook receiver that verifies signatures over
  the raw request bytes, and idempotent fulfilment.
- A local payment adapter used when no Stripe key is configured. It signs webhooks with
  the same HMAC scheme Stripe uses and delivers them to the same endpoint, so signature
  verification, deduplication and fulfilment run identically either way. This is what lets
  a reviewer with no Stripe account complete a real purchase with one command.
- Explicit handling for the awkward paths: a replayed webhook, a declined card, an expired
  session, and the webhook arriving before the browser redirect.

**Event-driven processing**

- A transactional outbox in both the `ordering` and `inventory` schemas. State changes and
  the messages announcing them commit together or not at all.
- A relay that publishes outbox rows to Kafka using `FOR UPDATE SKIP LOCKED`, so it scales
  past a single replica without changes.
- A fulfilment consumer running with manual offset commits: inventory is committed over
  gRPC first, then one PostgreSQL transaction claims the message in an inbox table and
  issues the tickets, and only then is the Kafka offset advanced. Killing the process at
  any point causes a redelivery that finds the work already done.
- Dead-letter topics for fulfilment and indexing, so one poisoned message cannot block
  everything behind it.

**Search**

- Elasticsearch full-text over event title, venue name and description, with `asciifolding`
  so German and English spellings match each other.
- Filters for city, date range and price range, and pagination with an accurate total and
  a guard against paging past Elasticsearch's result window.
- Indexing happens asynchronously off the outbox, so a failed index write can never fail
  an event creation. If Elasticsearch is unreachable at read time, search degrades to a
  PostgreSQL query and the response says so, rather than looking empty.

**Realtime**

- Remaining inventory is pushed to every browser viewing an event page over Socket.IO.
  Each API instance consumes the inventory topic under a consumer group unique to its
  process, because every instance must see every message in order to push it to the
  sockets it holds.

**gRPC**

- `packages/contracts/proto/inventory.proto` defines the inventory service, with generated
  TypeScript committed alongside it so the wire contract is readable without installing
  `protoc`. `Hold`, `Commit` and `Release` are all idempotent on the order id.

**Testing**

- Vitest unit tests over the pure domain rules: pricing and fee rounding, inventory limits
  and transitions, idempotency key derivation, and the order state machine.
- Playwright end-to-end tests against the real stack, covering browse, search, checkout,
  confirmation, a declined card, a replayed webhook, and two browsers watching one
  inventory counter move together. One test asserts that a single trace reaches Tempo
  carrying spans from all three services.
- GitHub Actions running lint, typecheck, build and unit tests, then bringing the stack up
  with the exact command from the README and running the end-to-end suite against it.

### Security

- Payment webhooks are rejected unless the signature over the raw body verifies, with a
  constant-time comparison and a five-minute timestamp tolerance so a valid-but-old
  signature cannot be replayed.
- Each service connects to PostgreSQL as its own role, granted rights only on the schema it
  owns. A cross-boundary read fails at the database rather than relying on review.
- Order confirmation pages are reached with an unguessable access token, and a missing
  order and a wrong token return the same 404 so order ids cannot be probed.

### Known limitations

- No authentication; checkout is by email as a guest. This was a scope decision.
- One PostgreSQL instance rather than one per service. Boundaries are enforced by grants.
- Kafka messages are JSON validated with zod rather than Avro with a schema registry.
- The outbox is polled rather than tailed with logical replication.
