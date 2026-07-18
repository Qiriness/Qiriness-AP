import { createManualOverrideResolver } from './content-resolvers/manual-override-resolver.mjs';
import { createPageMetafieldResolver } from './content-resolvers/page-metafield-resolver.mjs';
import { createPageBodyResolver } from './content-resolvers/page-body-resolver.mjs';
import { createThemeTemplateResolver } from './content-resolvers/theme-template-resolver.mjs';

export function createKnowledgeSourceResolver({ config, themeClient }) {
  const resolvers = [
    createManualOverrideResolver(config),
    createPageMetafieldResolver(config),
    createPageBodyResolver(),
    createThemeTemplateResolver(themeClient)
  ];

  return {
    resolverOrder: resolvers.map((resolver) => resolver.name),
    async resolve(source) {
      const attempts = [];

      for (const resolver of resolvers) {
        const result = await resolver.resolve(source);
        attempts.push({
          name: resolver.name,
          found: result.found,
          reason: result.reason || null,
          metadata: result.metadata || null
        });

        if (!result.found) {
          continue;
        }

        return {
          ...result,
          resolverOrder: resolvers.map((item) => item.name),
          attemptedResolvers: attempts
        };
      }

      return {
        found: false,
        resolverOrder: resolvers.map((item) => item.name),
        attemptedResolvers: attempts
      };
    }
  };
}
