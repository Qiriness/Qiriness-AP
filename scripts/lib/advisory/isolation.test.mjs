import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// THE ADVISORY CORE IS CHANNEL-FREE, AND NOTHING ELSE DEPENDS ON IT YET.
//
// scripts/lib/advisory/ is meant to be lifted out for the email agent later
// without a rewrite, so it imports nothing outside its own directory. And the
// email agent and the dashboard must not start depending on unfinished
// chatbot code: only the storefront advisor (and its scripts) may import it.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

const importsOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the advisory core imports only from its own directory and node built-ins', () => {
  for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    for (const spec of importsOf(path.join(here, file))) {
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `${file} imports ${spec}`);
    }
  }
});

test('the support agent and the dashboard do not import the advisory core', () => {
  const allowed = [
    path.join(root, 'scripts', 'lib', 'advisory'),
    path.join(root, 'scripts', 'lib', 'storefront-chat'),
    path.join(root, 'scripts', 'advisor'),
    path.join(root, 'scripts', 'eval-advisory.mjs'),
    path.join(root, 'supabase', 'migrations', '80_advisor.test.mjs'),
    path.join(root, 'web', 'lib', 'server', 'storefront-chat-service.ts')
  ];
  const files = [...walk(path.join(root, 'agent')), ...walk(path.join(root, 'web')), ...walk(path.join(root, 'scripts')), ...walk(path.join(root, 'supabase'))];
  for (const file of files) {
    if (allowed.some((a) => file === a || file.startsWith(a + path.sep))) continue;
    for (const spec of importsOf(file)) {
      assert.ok(!/\/advisory\//.test(spec) && !/advisor-(tools|state)/.test(spec), `${path.relative(root, file)} imports ${spec}`);
    }
  }
});
