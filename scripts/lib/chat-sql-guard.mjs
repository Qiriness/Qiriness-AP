/**
 * The management chat's SQL gate: what a model-written query has to look like
 * before it is sent to the database.
 *
 * NOT THE SECURITY BOUNDARY. The database is. `mgmt_chat_ro`
 * (17_management_chat.sql) holds USAGE on the `chat` schema and SELECT on its
 * views and nothing else; every query runs inside a READ ONLY transaction with a
 * 10 s timeout (chat-sql-executor.mjs); and it is sent wrapped in a subquery,
 * where Postgres itself refuses a second statement (the text no longer parses)
 * and any data-modifying CTE ("must be at the top level").
 *
 * THIS LAYER EXISTS FOR THE MODEL. A refusal here comes back as a sentence the
 * model can correct from ("only the chat schema"), where a permission error from
 * Postgres reads like a bug and tends to get retried unchanged. So the lists
 * below are about clear feedback, not completeness — a query that slips past
 * them still meets the role.
 *
 * Pure: no I/O, no clock.
 */

/** The most rows one query may return. One more is fetched to detect truncation. */
export const MAX_ROWS = 1000;

export const MAX_SQL_LENGTH = 20_000;

/**
 * Words that only ever start or belong to a statement that changes something.
 * Checked on the skeleton (string contents blanked), so `category = 'delete
 * account'` is not refused, and on whole words, so `shopify_updated_at` is not
 * `update`.
 */
const BLOCKED_KEYWORDS = Object.freeze([
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'alter',
  'create',
  'drop',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'execute',
  'prepare',
  'listen',
  'notify',
  'lock',
  'vacuum',
  'analyze',
  'refresh',
  'set',
  'reset',
  // `SELECT ... INTO new_table` creates a table.
  'into'
]);

/**
 * Functions that change a setting or run a query given as text — each a way
 * round the checks above. `set_config` could lift the statement timeout for the
 * rest of the transaction; `query_to_xml('...')` runs whatever string it is given.
 */
const BLOCKED_FUNCTION = /\b(set_config|\w*_to_xml\w*|dblink\w*|lo_\w+)\s*\(/;

/** The catalogues. Everything the model may read is in the schema text it is given. */
const SYSTEM_IDENTIFIER = /\b(pg_\w+|information_schema)\b/;

/** A qualified name in any schema but `chat`. */
const OTHER_SCHEMA =
  /\b(public|auth|storage|vault|extensions|graphql|graphql_public|realtime|pgbouncer|net|cron|supabase_\w+)\s*\.\s*[a-z_]/;

function refuse(error) {
  return { ok: false, error };
}

/**
 * Walks the text once, separating what is SQL from what is literal.
 *
 * Returns `code` (comments removed, literals intact — what is executed) and
 * `skeleton` (comments removed, string contents blanked — what is checked), or
 * `{error}` for something that cannot be read safely.
 *
 * Dollar quoting is refused outright rather than parsed: nothing a SELECT over
 * a handful of views needs is written that way, and a tag-matching parser is
 * the kind of code that is wrong on the one input that matters.
 */
export function scanSql(input) {
  const text = String(input ?? '');
  let code = '';
  let skeleton = '';
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      code += ' ';
      skeleton += ' ';
      continue;
    }

    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return { error: 'The query has an unterminated /* comment.' };
      i = end + 2;
      code += ' ';
      skeleton += ' ';
      continue;
    }

    if (char === '$') {
      return {
        error: 'Dollar signs are not accepted: write literal values in single quotes, directly in the query.'
      };
    }

    if (char === "'") {
      // E'...' strings treat a backslash as an escape; ordinary strings do not.
      const escapes = /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return { error: 'The query has an unterminated string literal.' };
        if (escapes && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      code += text.slice(i, j + 1);
      skeleton += "''";
      i = j + 1;
      continue;
    }

    if (char === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return { error: 'The query has an unterminated quoted identifier.' };
      code += text.slice(i, end + 1);
      // The name is kept, unquoted, so `"public".tickets` is still a schema reference.
      skeleton += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    code += char;
    skeleton += char;
    i += 1;
  }

  return { code, skeleton };
}

/**
 * May this query be run? `{ok: true, sql}` with comments and one trailing
 * semicolon removed, or `{ok: false, error}` with a sentence for the model.
 */
export function checkSql(input) {
  const raw = String(input ?? '');
  if (!raw.trim()) return refuse('The query is empty.');
  if (raw.length > MAX_SQL_LENGTH) {
    return refuse(`The query is longer than ${MAX_SQL_LENGTH} characters; break the question into smaller queries.`);
  }

  const scanned = scanSql(raw);
  if (scanned.error) return refuse(scanned.error);

  const trailing = /;\s*$/;
  const code = scanned.code.replace(trailing, '');
  const skeleton = scanned.skeleton.replace(trailing, '').toLowerCase();

  if (skeleton.includes(';')) return refuse('Send one statement at a time: the query contains more than one.');
  if (!/^[\s(]*(select|with)\b/.test(skeleton)) return refuse('Only SELECT or WITH queries can be run.');

  const keyword = BLOCKED_KEYWORDS.find((word) => new RegExp(`\\b${word}\\b`).test(skeleton));
  if (keyword) {
    return refuse(`${keyword.toUpperCase()} is not allowed: this connection is read-only and runs plain SELECT/WITH queries only.`);
  }
  if (BLOCKED_FUNCTION.test(skeleton)) return refuse('That function is not available on this connection.');
  if (SYSTEM_IDENTIFIER.test(skeleton)) {
    return refuse('The system catalogues are not available. The schema you were given lists everything you can query.');
  }
  if (OTHER_SCHEMA.test(skeleton)) return refuse('Only views in the chat schema can be queried, e.g. chat.orders.');

  return { ok: true, sql: code.trim() };
}

/**
 * The statement actually sent: the checked query as a subquery, capped one row
 * past `maxRows` so a full page can be told from a cut-off one.
 *
 * The newlines matter. A query ending in a `--` comment would otherwise comment
 * out the closing parenthesis — `checkSql` strips comments, and this does not
 * rely on it.
 */
export function wrapForExecution(sql, maxRows = MAX_ROWS) {
  return `select * from (\n${sql}\n) as chat_result limit ${maxRows + 1}`;
}
