<!-- Part of DECISIONS.md (the index). Moved here verbatim on 2026-10-12; headings unchanged, so "DECISIONS.md § <heading>" references resolve with grep. -->

## Interface language

### The UI language is a person's choice and never the customer's language

The dashboard is offered in French (default) and English, chosen per person in the user menu. It changes only what the dashboard says. Drafts, acknowledgement templates, customer emails and everything the agent writes keep following the *customer's* language, so switching a screen to English cannot change what is sent.

- **No locale in the URL.** URLs already carry reading state (`?range=`, `?ticket=`) and `middleware.ts` matches role rules on paths, so `/fr/...` would collide with both. The choice is the `qos_lang` cookie, which Server Components read, mirrored to the account's `user_metadata.locale` (written with the person's own token, no service key) so it follows them to another browser; sign-in restores the cookie.
- **A typed dictionary, not a library.** `en.ts` owns the keys and `fr.ts` is typed `Record<MessageKey, string>`, so a missing French string fails `tsc`. Plurals are `key_one` / `key_other` through `Intl.PluralRules` because French counts 0 as singular.
- **Services return codes and parameters, not sentences** (applies as each panel is converted): a `blockedReason` or an activity title built in English on the server cannot follow the reader. Raw upstream errors stay as they are.
- **Stored content is not translated**: customer mail, drafts, product names, topic-map labels, situation names and agent-written investigation text are written once per ticket, not per viewer.
- **Default is French** (decided 2026-09-29), for anyone who has not chosen.

### Where a translated screen gets its words

- **Enum labels are keys, not maps.** A category, status, level, team, need or sender is `t(`category.${key}`)` against `messages/shared.ts`, so Insights, Agent setup and Tickets say the same thing in one place. The old `*_LABELS` maps in `lib/types.ts` stay only for screens not converted yet; delete each once its last reader moves.
- **Helpers that produced English take `t`** (`formatRelativeTime`, `outboundLine`, `decisionLabel`, `handedOffNotice`). `formatRelativeTime` defaults to English so unconverted callers keep working.
- **A server row that must be translated ships a code beside its sentence.** `TicketActivityEvent` keeps `title`/`detail` in English as the fallback and adds `tool` / `verdict`; the screen translates what it recognises and prints the rest raw. The agent's own per-ticket prose is never translated (see the rule above): a French reader sees English situation names and findings until that is decided separately.

### Insights: what is translated where

- **The kit cannot call a hook.** `InsightsKit` is rendered by Server Components and imported by Client ones, and a Server Component cannot read React context. So kit words go through `<Tx k="…">` (a client component that calls `t`), numbers through `KitText`, and a view that needs a plain string uses `getT()` (server) or `useT()` (client) itself.
- **Shared modules that also feed the monthly report stay English.** `insights-range.mjs`, `insights-freshness.mjs`, `sales-overview.mjs`, `segment-finder.mjs` build English sentences for the worker's HTML report. The dashboard does not edit them: it rebuilds the words from their structured output (`insights-labels.ts`, `segment-messages.ts`), and freshness items gained a `code` for that. The "Management signals" sentences are the exception still shown in English.
- **A blocked reason is a key or a raw string.** `<Tx k={reason}>` prints the translation when the string is a dictionary key and the string itself otherwise, which is how a Shopify error message passes through.
- **Numbers are hand-built, per language.** French groups with a no-break space and uses a decimal comma; both are produced by `insights-format.ts` rather than `Intl`, because Node and Chrome disagree on `Intl`'s separators and one differing character fails hydration (already the reason this file was hand-built).
