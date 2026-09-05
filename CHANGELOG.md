# Changelog

Notable changes to this project. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written for someone who has never seen this repository. They say what changed
and, where it is not obvious, why.

## [0.1.0] 2026-09-05

The first working version. Everything below landed together as the initial build, so this
entry runs longer than a release note normally would.

### The platform

A ticketing domain: venues host events, events sell ticket types with finite inventory,
and customers buy through a checkout. No admin portal, no reviews, no recommendations. The
scope was kept small so the remaining pieces could be built properly.

Three backend services. `api` serves the public REST API and the WebSocket gateway,
`inventory` speaks gRPC only and is the sole writer of stock, and `worker` runs the Kafka
consumers. A Vue 3 single page app sits in front of them.

One `docker compose up` starts everything, Kafka and Elasticsearch and Prometheus and
Grafana included. There is no second setup step.

A seed script loads nine events across real Berlin venues so the application is never
empty on a first run. It goes through the public API rather than straight into the
database, which means seeding also proves the creation pipeline works.

### Observability

OpenTelemetry across all three services, loaded via `node --require` so instrumentation is
registered before any application module is imported.

Traces span the HTTP handler, Postgres, gRPC, the payment webhook, Kafka, the consumer in
another process, gRPC again and Postgres again. Roughly 70 spans for a single purchase.
Trace context is stored on the order at checkout, resumed by the webhook handler, and
restored around each outbox publish, so the asynchronous half of a checkout belongs to the
trace that started when the customer pressed buy.

RED metrics per endpoint from a single histogram, labelled by route template rather than
raw path so cardinality stays bounded.

Extra signals for the parts that fail quietly: outbox backlog, Kafka consumption by
outcome, gRPC latency, idempotency suppressions, search index failures, live socket count.

A Grafana dashboard committed as JSON and provisioned on startup, along with the
Prometheus and Tempo datasources.

`npm run demo:checkout` drives a complete purchase and prints a link to its trace.

### Payments

Stripe Checkout sessions in test mode, a webhook receiver that verifies signatures over
the raw request bytes, and idempotent fulfilment.

A local payment adapter takes over when no Stripe key is configured. It signs webhooks
with the same HMAC scheme Stripe uses and delivers them to the same endpoint, so signature
verification, deduplication and fulfilment run identically either way. That is what lets
someone with no Stripe account complete a real purchase with one command.

Explicit handling for the awkward paths: a replayed webhook, a late webhook carrying a new
event id, a declined card, an expired session, and the webhook arriving before the browser
redirect.

### Event-driven processing

A transactional outbox in both the `ordering` and `inventory` schemas. State changes and
the messages announcing them commit together or not at all.

A relay publishes outbox rows to Kafka using `FOR UPDATE SKIP LOCKED`, so it scales past a
single replica without changes.

The fulfilment consumer runs with manual offset commits. Inventory is committed over gRPC
first, then one Postgres transaction claims the message in an inbox table and issues the
tickets, and only then does the Kafka offset advance. Killing the process at any point
causes a redelivery that finds the work already done.

Dead letter topics for fulfilment and indexing, so one poisoned message cannot block
everything behind it. Messages that fail validation are dead lettered on the first
attempt, since a payload missing a required field will still be missing it on the tenth.

### Search

Elasticsearch full text over event title, venue name and description, with `asciifolding`
so German and English spellings match each other.

Filters for city, date range and price range, with pagination that reports an accurate
total and guards against paging past the result window.

Indexing happens asynchronously off the outbox, so a failed index write can never fail an
event creation. If Elasticsearch is unreachable at read time, search degrades to a
Postgres query and the response says so rather than looking empty.

### Realtime

Remaining inventory is pushed to every browser viewing an event page over Socket.IO. Each
API instance consumes the inventory topic under a consumer group unique to its process,
because every instance must see every message in order to push it to the sockets it holds.

### gRPC

`packages/contracts/proto/inventory.proto` defines the inventory service, with generated
TypeScript committed alongside it so the wire contract is readable without installing
protoc. `Hold`, `Confirm`, `Commit` and `Release` are all idempotent on the order id.

### Testing

Vitest unit tests over the pure domain rules: pricing and fee rounding, inventory limits
and transitions, idempotency key derivation, and the order state machine. 100% statement
and function coverage of the domain package.

Playwright end-to-end tests against the real stack, covering browse, search, checkout,
confirmation, a declined card, a replayed webhook, two browsers watching one inventory
counter move together, and a paid order surviving its hold expiring while the consumer is
down. One test asserts that a single trace reaches Tempo carrying spans from all three
services.

GitHub Actions runs lint, typecheck, build and unit tests, then brings the stack up with
the exact command from the README and runs the end-to-end suite against it.

### Security

Payment webhooks are rejected unless the signature over the raw body verifies, using a
constant time comparison and a five minute timestamp tolerance so a valid but old
signature cannot be replayed.

Each service connects to Postgres as its own role, granted rights only on the schema it
owns. A cross-boundary read fails at the database rather than relying on review.

Order confirmation pages are reached with an unguessable access token, and a missing order
and a wrong token return the same 404 so order ids cannot be probed.

### Known limitations

No authentication. Checkout is by email as a guest, which was a scope decision.

One Postgres instance rather than one per service, with boundaries enforced by grants.

Kafka messages are JSON validated with zod rather than Avro with a schema registry.

The outbox is polled rather than tailed with logical replication.

Real Stripe test mode has not been run end to end. Every run so far used the local payment
adapter. The Stripe adapter compiles and is wired up but has never executed against the
real API.
