import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const migration = readFileSync(new URL('./004_brand_voice_profile.sql', import.meta.url), 'utf8');

test('brand voice profile migration adds a jsonb voice_profile column with a safe default', () => {
  assert.match(migration, /add column voice_profile jsonb not null default '\{\}'::jsonb/i);
});

test('brand voice profile migration documents the column shape and always-include intent', () => {
  assert.match(migration, /comment on column public\.knowledge_documents\.voice_profile is/i);
  assert.match(migration, /roleDescription: string, toneAndVoice: string/i);
});
