import { normalizePlainText, slugify } from '../../html-to-text.mjs';
import { fetchMainTheme, fetchThemeAsset } from '../../shopify-theme-client.mjs';
import { extractSemanticUnits } from '../template-extractors/index.mjs';

const MIN_TEXT_LENGTH = 30;

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
    if (text.length < MIN_TEXT_LENGTH) {
      return { found: false, reason: 'empty_theme_liquid_asset' };
    }

    const heading = source.title;
    const sections = [
      {
        heading,
        text,
        order: 0,
        anchor: slugify(heading || `${source.handle}-1`),
        unit_type: null,
        confidence: 'medium',
        metadata: { sectionId: assetKey, sectionType: 'liquid_asset', blockId: null, blockType: null, position: 0 }
      }
    ];
    return foundResult(text, sections, assetKey);
  }

  let template;
  try {
    template = JSON.parse(value);
  } catch {
    return { found: false, reason: 'invalid_theme_template_json' };
  }

  const units = extractSemanticUnits(template);
  const sections = semanticUnitsToSections(units, source);
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

  return foundResult(text, sections, assetKey);
}

function semanticUnitsToSections(units, source) {
  return units.map((unit, index) => {
    const heading = unitHeading(unit) || source.title;
    return {
      heading,
      text: unitText(unit),
      order: index,
      anchor: slugify(heading || `${source.handle}-${index + 1}`),
      unit_type: unit.type,
      confidence: unit.confidence || 'medium',
      metadata: {
        ...(unit.category !== undefined ? { category: unit.category } : {}),
        ...unit.sourceRef
      }
    };
  });
}

function unitHeading(unit) {
  return unit.type === 'faq_item' ? unit.question : unit.heading || null;
}

function unitText(unit) {
  return unit.type === 'faq_item' ? unit.answer : unit.text;
}

function foundResult(text, sections, assetKey) {
  return {
    found: true,
    text,
    sections,
    origin: 'theme_template',
    confidence: 'medium',
    metadata: {
      template_asset_key: assetKey,
      extracted_sections: sections.map((section) => ({
        section_id: section.metadata?.sectionId ?? null,
        section_type: section.metadata?.sectionType ?? null,
        block_id: section.metadata?.blockId ?? null,
        block_type: section.metadata?.blockType ?? null,
        position: section.metadata?.position ?? null,
        unit_type: section.unit_type,
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
