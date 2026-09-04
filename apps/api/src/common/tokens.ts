/**
 * Injection tokens, kept out of infra.module so that a provider needing a token
 * never has to import the module that declares its own providers. A circular
 * require in CommonJS yields `undefined` at decoration time and surfaces as an
 * opaque "Nest can't resolve dependencies" error at startup.
 */
export const PG_POOL = Symbol('PG_POOL');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');
export const ELASTIC_CLIENT = Symbol('ELASTIC_CLIENT');
export const ORDERING_RELAY = Symbol('ORDERING_RELAY');
export const INVENTORY_CLIENT = 'INVENTORY_PACKAGE_CLIENT';
