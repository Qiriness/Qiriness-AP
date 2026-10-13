// Proves the baseline: builds a fresh database from supabase/migrations/00_baseline.sql on an
// in-process Postgres (PGlite), describes its catalogue and compares it with the committed
// description, or with production. Numbered files after the baseline (changes not yet applied to
// production) must apply on top of it.
//
//   npm run db:check:baseline                 against supabase/migrations/00_baseline.catalog.json
//   npm run db:check:baseline -- --production  against the live database (read-only)
//
// Exit 1 on any difference. No network needed without --production.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import pg from 'pg';

import { describeCatalog, diffCatalogs } from './lib/schema-catalog.mjs';
import { loadEnv } from './lib/sync-config.mjs';

const DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
export const BASELINE = `${DIR}00_baseline.sql`;
export const CATALOG = `${DIR}00_baseline.catalog.json`;

/**
 * Differences that are the same schema written two ways. Postgres stores a CHECK as an expression
 * tree; printing it and parsing the print back can regroup an AND chain — ((A AND B) AND C) becomes
 * (A AND B AND C). AND is associative, so the constraint is identical. Listed by exact text, so
 * anything else still fails.
 */
const EQUIVALENT = [
  [
    'social_post_tags_name_check: CHECK ((((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 40)) AND (name = btrim(name))))',
    'social_post_tags_name_check: CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 40) AND (name = btrim(name))))'
  ]
];

/** What Supabase provides and PGlite does not: the API roles, and vault (the token functions use it). */
const SUPABASE_STAND_INS = `
  create role anon; create role authenticated; create role service_role;
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text, description text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
    returns uuid language sql as $$ insert into vault.secrets(name, secret, description) values (new_name, new_secret, new_description) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
    returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;`;

/** The migrations a fresh database runs: the baseline, then 01_… onwards, in name order. */
export function migrationFiles() {
  return readdirSync(DIR).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort().map((f) => `${DIR}${f}`);
}

export async function buildFresh(files = migrationFiles()) {
  const db = new PGlite({ extensions: { vector, unaccent, uuid_ossp } });
  await db.exec(SUPABASE_STAND_INS);
  for (const file of files) {
    const sql = readFileSync(file, 'utf8')
      .replace(/create extension if not exists pgcrypto with schema extensions;/, '-- pgcrypto: not in PGlite; nothing calls it')
      .replace(/create extension if not exists supabase_vault with schema vault;/, '-- vault: stood in for');
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`${file.slice(DIR.length)} failed on a fresh database: ${error.message}`);
    }
  }
  return db;
}

export function withoutEquivalents(diffs) {
  const flat = EQUIVALENT.flat();
  return diffs.filter((d) => !flat.some((text) => d.endsWith(JSON.stringify(text).slice(0, 200))));
}

async function main() {
  // The baseline alone must equal what production had when it was generated. A
  // numbered file after it is a change not yet applied to production: it must
  // apply on top, and is compared once applied and the baseline regenerated.
  const t = Date.now();
  const pending = migrationFiles().filter((f) => f !== BASELINE);
  for (const file of pending) {
    const db = await buildFresh([BASELINE, ...pending.slice(0, pending.indexOf(file) + 1)]);
    await db.close();
    console.log(`pending ${file.slice(DIR.length)}: applies on top of the baseline`);
  }
  const db = await buildFresh([BASELINE]);
  console.log(`built a fresh database from the baseline in ${Date.now() - t} ms`);
  const built = await describeCatalog({ query: async (text, params) => ({ rows: (await db.query(text, params)).rows }) });

  let expected;
  if (process.argv.includes('--production')) {
    const client = new pg.Client({ connectionString: loadEnv().SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query('begin read only');
      expected = await describeCatalog(client);
    } finally {
      await client.query('rollback').catch(() => {});
      await client.end();
    }
  } else {
    expected = JSON.parse(readFileSync(CATALOG, 'utf8'));
  }

  const diffs = withoutEquivalents(diffCatalogs(expected, built));
  console.log(`tables ${Object.keys(built.tables).length}, views ${Object.keys(built.views).length}, functions ${Object.keys(built.functions).length}, indexes ${built.indexes.length}, triggers ${built.triggers.length}, comments ${built.comments.length}`);
  if (diffs.length) {
    console.log(`${diffs.length} DIFFERENCES (first = ${process.argv.includes('--production') ? 'production' : 'committed catalogue'}, second = fresh build):`);
    for (const d of diffs.slice(0, 50)) console.log(`  ${d}`);
    process.exitCode = 1;
  } else {
    console.log(`identical to ${process.argv.includes('--production') ? 'production' : 'the committed catalogue'} (${EQUIVALENT.length} known-equivalent rewording allowed)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
