import { htmlToSections, htmlToText } from '../../html-to-text.mjs';

export function createPageBodyResolver() {
  return {
    name: 'page_body',
    async resolve(source) {
      const bodyText = htmlToText(source.page.body);
      if (!bodyText) {
        return { found: false, reason: 'empty_page_body' };
      }

      return {
        found: true,
        text: bodyText,
        sections: htmlToSections(source.page.body, source.title),
        origin: 'page_body',
        confidence: 'high',
        metadata: {
          body_length: source.page.body.length
        }
      };
    }
  };
}
