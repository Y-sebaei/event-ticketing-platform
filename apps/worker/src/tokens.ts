/**
 * Injection tokens live in their own module rather than in app.module.
 *
 * app.module imports every provider, and every provider needs these tokens. If
 * they were declared in app.module the import graph would be circular, and a
 * circular require in CommonJS resolves to `undefined` at decoration time —
 * which fails as an unhelpful "Nest can't resolve dependencies" error at
 * startup rather than as a compile error.
 */
export const PG_POOL = Symbol('PG_POOL');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');
export const ELASTIC_CLIENT = Symbol('ELASTIC_CLIENT');
export const INVENTORY_CLIENT = 'INVENTORY_PACKAGE_CLIENT';
