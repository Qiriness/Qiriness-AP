import { existsSync, readFileSync } from 'node:fs';
import { htmlToSections, htmlToText, normalizePlainText } from '../../html-to-text.mjs';

export function createManualOverrideResolver(config) {
  const overrides = loadOverrides(config.knowledgeManualOverridesPath);

  return {
    name: 'manual_override',
    async resolve(source) {
      const override = overrides.get(source.sourceId) || overrides.get(source.handle);
      if (!override) {
        return notFound('missing_override');
      }

      const text = normalizePlainText(override.text || htmlToText(override.html));
      if (!text) {
        return notFound('empty_override');
      }

      return {
        found: true,
        text,
        sections: override.sections || htmlToSections(override.html || override.text, source.title),
        origin: 'manual_override',
        confidence: 'high',
        metadata: {
          override_key: source.sourceId,
          override_path: config.knowledgeManualOverridesPath
        }
      };
    }
  };
}

function loadOverrides(path) {
  const overrides = new Map();
  if (!path || !existsSync(path)) {
    return overrides;
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    overrides.set(key, value);
  }

  return overrides;
}

function notFound(reason) {
  return { found: false, reason };
}
