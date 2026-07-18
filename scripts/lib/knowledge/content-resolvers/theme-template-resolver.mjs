import { htmlToText, normalizePlainText } from '../../html-to-text.mjs';
import { fetchMainTheme, fetchThemeAsset } from '../../shopify-theme-client.mjs';
import { cleanTextValue } from '../../text-cleaning.mjs';

const MIN_TEXT_LENGTH = 30;
const TEXT_KEY_PATTERN = /(text|title|heading|subheading|description|content|question|answer|label|richtext|caption|quote)/i;
const IGNORED_KEY_PATTERN = /(color|colour|image|video|url|link|button|icon|id|class|padding|margin|width|height|size|layout|style|collection|product)/i;

export function createThemeTemplateResolver(themeClient) {
  return {
    name: 'theme_template',
    async resolve(source) {
      const theme = await fetchMainTheme(themeClient);
      if (!theme) {
        return { found: false, reason: `theme_unavailable: ${themeClient.unavailableReason || 'unknown'}` };
      }

      const attemptedAssetKeys = templateAssetKeys(source.page.templateSuffix);
      for (const assetKey of attemptedAssetKeys) {
        const asset = await fetchThemeAsset(themeClient, assetKey);
        if (!asset?.value) {
          continue;
        }

        const resolved = resolveTemplateAsset(source, assetKey, asset.value, theme);
        if (resolved.found) {
          return {
            ...resolved,
            metadata: {
              ...resolved.metadata,
              theme_id: theme.id,
              theme_name: theme.name,
              theme_role: theme.role,
              attempted_asset_keys: attemptedAssetKeys
            }
          };
        }
      }

      return {
        found: false,
        reason: 'missing_theme_template_text',
        metadata: {
          theme_id: theme.id,
          theme_name: theme.name,
          attempted_asset_keys: attemptedAssetKeys
        }
      };
    }
  };
}

function resolveTemplateAsset(source, assetKey, value, theme) {
  if (!assetKey.endsWith('.json')) {
    const text = normalizePlainText(value);
    return text.length >= MIN_TEXT_LENGTH
      ? foundResult(source, text, [{ key: assetKey, type: 'liquid_asset', text }])
      : { found: false, reason: 'empty_theme_liquid_asset' };
  }

  let template;
  try {
    template = JSON.parse(value);
  } catch {
    return { found: false, reason: 'invalid_theme_template_json' };
  }

  const sections = extractThemeTemplateSections(template);
  const text = normalizePlainText(sections.map((section) => section.text).join('\n\n'));
  if (text.length < MIN_TEXT_LENGTH) {
    return {
      found: false,
      reason: 'empty_theme_template_settings',
      metadata: {
        theme_id: theme.id,
        template_asset_key: assetKey
      }
    };
  }

  return foundResult(source, text, sections, assetKey);
}

function foundResult(source, text, sections, assetKey = null) {
  return {
    found: true,
    text,
    sections: sections.map((section, index) => ({
      heading: section.heading || source.title,
      text: section.text,
      order: index,
      anchor: section.anchor || slugify(section.heading || `${source.handle}-${index + 1}`)
    })),
    origin: 'theme_template',
    confidence: 'medium',
    metadata: {
      template_asset_key: assetKey,
      extracted_sections: sections.map((section) => ({
        section_key: section.key,
        section_type: section.type,
        heading: section.heading
      }))
    }
  };
}

function templateAssetKeys(templateSuffix) {
  const suffix = templateSuffix || null;
  const keys = suffix
    ? [`templates/page.${suffix}.json`, `templates/page.${suffix}.liquid`]
    : [];

  keys.push('templates/page.json', 'templates/page.liquid');
  return [...new Set(keys)];
}

function extractThemeTemplateSections(template) {
  const sections = template.sections || {};
  const orderedKeys = Array.isArray(template.order)
    ? [...template.order, ...Object.keys(sections).filter((key) => !template.order.includes(key))]
    : Object.keys(sections);

  return orderedKeys
    .map((key) => sectionText(key, sections[key]))
    .filter((section) => section.text.length >= MIN_TEXT_LENGTH);
}

function sectionText(key, section) {
  const values = extractTextSettings(section);
  const heading = values.find((item) => /title|heading|question/i.test(item.key))?.text || null;

  return {
    key,
    type: section?.type,
    heading,
    text: normalizePlainText(values.map((item) => item.text).join('\n\n')),
    anchor: slugify(heading || key)
  };
}

function extractTextSettings(value, path = []) {
  if (typeof value === 'string') {
    const key = path.at(-1) || '';
    if (!isContentSetting(key, value)) {
      return [];
    }
    return [{ key, text: cleanMarkupText(value) }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => extractTextSettings(item, [...path, String(index)]));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => extractTextSettings(entry, [...path, key]));
  }

  return [];
}

function isContentSetting(key, value) {
  const text = cleanMarkupText(value);
  if (text.length < 2) {
    return false;
  }
  if (IGNORED_KEY_PATTERN.test(key)) {
    return false;
  }
  if (TEXT_KEY_PATTERN.test(key)) {
    return true;
  }
  return hasSentenceLikeText(text);
}

function cleanMarkupText(value) {
  const raw = cleanTextValue(String(value || ''));
  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return htmlToText(raw);
  }

  return normalizePlainText(
    raw
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .replace(/\{%[\s\S]*?%\}/g, ' ')
  );
}

function hasSentenceLikeText(value) {
  return /[A-Za-zÀ-ÿ]{3,}/.test(value) && value.split(/\s+/).length >= 4;
}

function slugify(value) {
  const slug = cleanTextValue(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}
