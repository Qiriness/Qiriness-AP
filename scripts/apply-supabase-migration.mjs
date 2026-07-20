import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import pg from 'pg';

import { loadEnv } from './lib/sync-config.mjs';

const { Client } = pg;

const migrationPath = process.argv[2];

if (!migrationPath) {
  console.error('Usage: node scripts/apply-supabase-migration.mjs supabase/migrations/file.sql');
  process.exitCode = 1;
} else {
  main(migrationPath).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main(filePath) {
  const env = loadEnv();
  if (!env.SUPABASE_DB_URL) {
    throw new Error('Missing SUPABASE_DB_URL.');
  }

  const sql = readFileSync(filePath, 'utf8');
  const client = new Client({
    connectionString: env.SUPABASE_DB_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  try {
    await client.query(sql);
    await client.query('select pg_notify($1, $2)', ['pgrst', 'reload schema']);
  } finally {
    await client.end();
  }

  console.log(`Applied ${basename(filePath)} and requested PostgREST schema reload.`);
}
