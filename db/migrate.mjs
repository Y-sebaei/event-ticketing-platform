#!/usr/bin/env node
/**
 * A migration runner in one file, with no framework.
 *
 * Each .sql file runs inside its own transaction and is recorded with a
 * checksum. Editing a migration that already ran is a hard failure rather than
 * a silent divergence between your machine and CI — the single most common way
 * a schema drifts.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

async function connectWithRetry(attempts = 30, delayMs = 1000) {
  for (let i = 1; i <= attempts; i++) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i === attempts) throw err;
      console.log(`[migrate] postgres not ready (${i}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

const client = await connectWithRetry();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename   text PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await client.query('SELECT filename, checksum FROM public.schema_migration');
  const appliedByName = new Map(applied.map((r) => [r.filename, r.checksum]));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const filename of files) {
    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = appliedByName.get(filename);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `[migrate] ${filename} changed after it was applied. Add a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    console.log(`[migrate] applying ${filename}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migration (filename, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
      await client.query('COMMIT');
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`[migrate] ${filename} failed: ${err.message}`, { cause: err });
    }
  }

  console.log(
    ran === 0
      ? `[migrate] schema already up to date (${files.length} migrations)`
      : `[migrate] applied ${ran} migration(s)`,
  );
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
