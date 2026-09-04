-- Runs once, on first boot of the Postgres container.
--
-- Three schemas, three roles, one instance. Each service connects as its own
-- role and is granted rights only on the schema it owns, so a cross-boundary
-- read fails at the database instead of relying on code review to catch it.
-- A production deployment would use three separate databases; the failure mode
-- is identical and this keeps `docker compose up` to one Postgres container.

CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS ordering;
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE ROLE svc_api      LOGIN PASSWORD 'svc_api';
CREATE ROLE svc_inventory LOGIN PASSWORD 'svc_inventory';
CREATE ROLE svc_worker   LOGIN PASSWORD 'svc_worker';

GRANT CONNECT ON DATABASE ticketing TO svc_api, svc_inventory, svc_worker;

-- api: owns the catalog, writes orders.
GRANT USAGE ON SCHEMA catalog, ordering TO svc_api;
-- worker: writes orders (tickets, inbox), reads the catalog only to rebuild
-- the search index from source of truth.
GRANT USAGE ON SCHEMA ordering TO svc_worker;
GRANT USAGE ON SCHEMA catalog  TO svc_worker;
-- inventory: the only role that may touch the inventory schema at all.
GRANT USAGE ON SCHEMA inventory TO svc_inventory;

-- Migrations run as `app`, which owns every table. These default privileges
-- mean tables created by future migrations are granted automatically and no
-- one has to remember to re-run a GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA catalog
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO svc_api;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA catalog
  GRANT SELECT ON TABLES TO svc_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA ordering
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO svc_api, svc_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA inventory
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO svc_inventory;

ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA catalog
  GRANT USAGE, SELECT ON SEQUENCES TO svc_api;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA ordering
  GRANT USAGE, SELECT ON SEQUENCES TO svc_api, svc_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA inventory
  GRANT USAGE, SELECT ON SEQUENCES TO svc_inventory;
