// Rewrites the widget's generated vocabulary blocks from the language packs (scripts/lib/i18n/).
//
//   npm run widget:words
//
// Run it after adding a language or changing a pack's `widget` words; i18n.test.mjs fails until then.

import fs from 'node:fs';

import { WIDGET_FILES, withWidgetBlock } from './lib/i18n/widget-words.mjs';

for (const [file, keys] of Object.entries(WIDGET_FILES)) {
  const source = fs.readFileSync(file, 'utf8');
  const next = withWidgetBlock(source, keys);
  if (next === null) {
    console.error(`${file}: no words:begin / words:end markers`);
    process.exitCode = 1;
    continue;
  }
  if (next === source) console.log(`${file}: up to date`);
  else {
    fs.writeFileSync(file, next);
    console.log(`${file}: rewritten`);
  }
}
