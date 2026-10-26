/**
 * The REST helpers' arguments as SQL, for the direct Postgres transport.
 *
 * WHY THIS EXISTS. Every PostgREST request is a line in Supabase's API logs
 * (~1.6 kB), and log ingest is a metered quota: 26k worker requests a day were
 * ~41 MB of the ~50 MB a day measured on 2026-10-26. A query over a direct
 * connection writes no such line. The helpers' callers keep their PostgREST
 * vocabulary — filters as `{ column: value | { operator, value } }`, `select`
 * and `order` strings — and this module turns it into the SQL PostgREST itself
 * would have run.
 *
 * THE SHAPE OF A RESULT IS POSTGRES'S JSON, NOT node-postgres'S TYPES. Each
 * query returns `json_agg` of its rows, the way PostgREST builds its response,
 * so a timestamp is the same ISO string, a bigint or numeric the same JSON
 * number, a jsonb column the same object. Read as plain rows, node-postgres
 * would hand back Date objects and numeric strings, and code that has only ever
 * seen PostgREST's JSON would break without an error.
 *
 * ONLY THE GRAMMAR IN USE. Columns, `alias:column`, JSON paths (`->`, `->>`),
 * casts; the operators below; `order` with nulls placement. Anything else — an
 * embedded resource, `or=`, full-text operators — throws rather than being
 * guessed at, so a new call shape fails on its first run instead of returning
 * different rows.
 *
 * Names are always quoted identifiers and values always parameters: nothing a
 * caller passes is spliced into the SQL text except through `ident`/`literal`.
 */

/** PostgREST's `db-max-rows` on Supabase: a read or a set-returning call never returns more. */
export const DB_MAX_ROWS = 1000;

const SCHEMA = 'public';

export function ident(name) {
  const text = String(name);
  if (!text || text.includes('\0')) throw new Error(`Invalid identifier ${JSON.stringify(name)}`);
  return `"${text.replace(/"/g, '""')}"`;
}

function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function tableRef(table) {
  return `${ident(SCHEMA)}.${ident(table)}`;
}

/** Collects parameters; `add` returns the `$n` placeholder for a value. */
export function createParams() {
  const values = [];
  return {
    values,
    add(value) {
      values.push(value);
      return `$${values.length}`;
    }
  };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const CAST = /^[A-Za-z_][A-Za-z0-9_ ]*(\[\])?$/;

/**
 * `column`, `column->a->>b`, `column->0`: the SQL expression and the name
 * PostgREST gives the result when there is no alias (the last key of a path).
 */
function parseField(text) {
  const source = text.trim();
  const parts = source.split(/(->>|->)/);
  const column = parts[0].trim();
  if (!NAME.test(column)) {
    throw new Error(`Unsupported column ${JSON.stringify(source)} for the direct transport`);
  }
  let sql = ident(column);
  let name = column;
  for (let i = 1; i < parts.length; i += 2) {
    const arrow = parts[i];
    const key = parts[i + 1]?.trim();
    if (!key) throw new Error(`Unsupported JSON path ${JSON.stringify(source)}`);
    sql += /^-?\d+$/.test(key) ? `${arrow}${Number(key)}` : `${arrow}${literal(key)}`;
    name = key;
  }
  return { sql, name };
}

/** The top-level items of a `select`, so a comma inside parentheses is not a split. */
function splitTopLevel(text) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const char of String(text)) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** A PostgREST `select` as a SQL select list. */
export function selectList(select = '*') {
  return splitTopLevel(select || '*').map((item) => {
    if (item === '*') return '*';
    if (item.includes('(')) {
      throw new Error(`Embedded resources are not supported by the direct transport: ${JSON.stringify(item)}`);
    }
    let rest = item;
    let alias = null;
    const aliasMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*):(?!:)(.+)$/);
    if (aliasMatch) {
      alias = aliasMatch[1];
      rest = aliasMatch[2];
    }
    let cast = null;
    const castAt = rest.indexOf('::');
    if (castAt !== -1) {
      cast = rest.slice(castAt + 2).trim();
      rest = rest.slice(0, castAt);
      if (!CAST.test(cast)) throw new Error(`Unsupported cast ${JSON.stringify(item)}`);
    }
    const field = parseField(rest);
    const expression = cast ? `(${field.sql})::${cast}` : field.sql;
    const name = alias ?? field.name;
    return expression === ident(name) ? expression : `${expression} AS ${ident(name)}`;
  }).join(', ');
}

/** PostgREST's `in.(a,"b,c")` list: commas split, double quotes group, backslash escapes. */
export function parseList(text) {
  const raw = String(text).trim();
  if (!raw.startsWith('(') || !raw.endsWith(')')) {
    throw new Error(`An in. filter takes a parenthesised list; got ${JSON.stringify(text)}`);
  }
  const body = raw.slice(1, -1);
  if (body.trim() === '') return [];
  const items = [];
  let current = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quoted) {
      if (char === '\\' && i + 1 < body.length) {
        current += body[++i];
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') {
      items.push(wasQuoted ? current : current.trim());
      current = '';
      wasQuoted = false;
    } else {
      current += char;
    }
  }
  items.push(wasQuoted ? current : current.trim());
  return items;
}

const COMPARE = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE', cs: '@>', cd: '<@', ov: '&&' };
const IS_VALUES = { null: 'NULL', true: 'TRUE', false: 'FALSE', unknown: 'UNKNOWN' };

function condition(lhs, operator, value, params) {
  if (operator.startsWith('not.')) {
    return `NOT (${condition(lhs, operator.slice(4), value, params)})`;
  }
  if (operator === 'is') {
    const keyword = IS_VALUES[String(value).toLowerCase()];
    if (!keyword) throw new Error(`An is. filter takes null, true, false or unknown; got ${JSON.stringify(value)}`);
    return `${lhs} IS ${keyword}`;
  }
  if (operator === 'in') {
    return `${lhs} = ANY(${params.add(parseList(value))})`;
  }
  const sqlOperator = COMPARE[operator];
  if (!sqlOperator) {
    throw new Error(`Filter operator ${JSON.stringify(operator)} is not supported by the direct transport`);
  }
  const text = String(value);
  // PostgREST's wildcard for like/ilike is `*`, so a URL need not carry `%`.
  return `${lhs} ${sqlOperator} ${params.add(operator === 'like' || operator === 'ilike' ? text.replace(/\*/g, '%') : text)}`;
}

/** The helpers' filters as a WHERE clause (empty string when there are none). */
export function whereClause(filters, params) {
  const parts = [];
  for (const [key, value] of Object.entries(filters || {})) {
    if (key === 'or' || key === 'and' || key.startsWith('not.')) {
      throw new Error(`Logical filter ${JSON.stringify(key)} is not supported by the direct transport`);
    }
    const lhs = parseField(key).sql;
    if (value && typeof value === 'object' && value.operator && Object.hasOwn(value, 'value')) {
      parts.push(condition(lhs, value.operator, value.value, params));
    } else {
      // The REST client sends `eq.${value}`: the value as text, whatever its type.
      parts.push(condition(lhs, 'eq', `${value}`, params));
    }
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

/** `a.asc,b.desc.nullslast` as an ORDER BY clause. */
export function orderClause(order) {
  if (!order) return '';
  const terms = splitTopLevel(order).map((term) => {
    const match = term.match(/^(.+?)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/);
    if (!match) throw new Error(`Unsupported order ${JSON.stringify(term)}`);
    const [, field, direction, nulls] = match;
    let sql = parseField(field).sql;
    if (direction) sql += ` ${direction.toUpperCase()}`;
    if (nulls) sql += nulls === 'nullsfirst' ? ' NULLS FIRST' : ' NULLS LAST';
    return sql;
  });
  return ` ORDER BY ${terms.join(', ')}`;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer; got ${JSON.stringify(value)}`);
  return number;
}

/** A read: one page, never more than DB_MAX_ROWS, returned as one JSON array. */
export function buildSelect({ table, select = '*', filters = {}, order, limit, offset }) {
  const params = createParams();
  const rowLimit = Math.min(limit === undefined || limit === null ? DB_MAX_ROWS : nonNegativeInteger(limit, 'limit'), DB_MAX_ROWS);
  let inner = `SELECT ${selectList(select)} FROM ${tableRef(table)}${whereClause(filters, params)}${orderClause(order)} LIMIT ${rowLimit}`;
  if (offset) inner += ` OFFSET ${nonNegativeInteger(offset, 'offset')}`;
  return { text: `SELECT coalesce(json_agg(_t), '[]'::json) AS body FROM (${inner}) _t`, values: params.values };
}

/** Rows written back, shaped by `select` as PostgREST's representation is. */
function representation(mutation, select) {
  return `WITH _r AS (${mutation} RETURNING *) SELECT coalesce(json_agg(_t), '[]'::json) AS body FROM (SELECT ${selectList(select || '*')} FROM _r) _t`;
}

function columnsOf(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) throw new Error('A write needs at least one column');
  return columns;
}

/**
 * Insert, or upsert when `onConflict` is given (PostgREST's merge-duplicates:
 * every column sent is overwritten). The rows travel as one JSON parameter and
 * are read with the table's own row type, the coercion PostgREST applies.
 */
export function buildInsert({ table, rows, onConflict, minimal }) {
  const params = createParams();
  const columns = columnsOf(rows);
  const list = columns.map(ident).join(', ');
  let mutation = `INSERT INTO ${tableRef(table)} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${tableRef(table)}, ${params.add(JSON.stringify(rows))}::json)`;
  if (onConflict) {
    const target = String(onConflict).split(',').map((column) => ident(column.trim())).join(', ');
    mutation += ` ON CONFLICT (${target}) DO UPDATE SET ${columns.map((column) => `${ident(column)} = EXCLUDED.${ident(column)}`).join(', ')}`;
  }
  return { text: minimal ? mutation : representation(mutation), values: params.values };
}

export function buildUpdate({ table, filters, row, select, minimal }) {
  const params = createParams();
  const columns = columnsOf([row]);
  const list = columns.map(ident).join(', ');
  // The row is read once, as the table's type; the parenthesised form keeps the
  // WHERE clause's columns the table's, with no join to make them ambiguous.
  const source = `(SELECT ${list} FROM json_populate_record(NULL::${tableRef(table)}, ${params.add(JSON.stringify(row))}::json))`;
  const mutation = `UPDATE ${tableRef(table)} SET (${list}) = ${source}${whereClause(filters, params)}`;
  return { text: minimal ? mutation : representation(mutation, select), values: params.values };
}

export function buildDelete({ table, filters, minimal }) {
  const params = createParams();
  const mutation = `DELETE FROM ${tableRef(table)}${whereClause(filters, params)}`;
  return { text: minimal ? mutation : representation(mutation), values: params.values };
}

/**
 * A function call, given its catalogue entry (see `pickFunction`). The
 * arguments travel as one JSON object read with `json_to_record` and the
 * function's own argument types, as PostgREST does; an argument left out takes
 * its default. The result keeps PostgREST's shape: an array for a set, the bare
 * value for a scalar, null for void.
 */
export function buildRpc({ fn, args }) {
  const params = createParams();
  const names = Object.keys(args || {});
  const call = `${tableRef(fn.name)}(${names.map((name) => `${ident(name)} := _a.${ident(name)}`).join(', ')})`;
  const from = names.length
    ? `json_to_record(${params.add(JSON.stringify(args))}::json) AS _a(${names.map((name) => `${ident(name)} ${fn.argTypes[name]}`).join(', ')})`
    : null;
  if (fn.returnsSet) {
    if (!fn.returnsRows) throw new Error(`rpc ${fn.name}: a set of scalars is not supported by the direct transport`);
    const source = from ? `${from}, LATERAL ${call} AS _f` : `${call} AS _f`;
    return { text: `SELECT coalesce(json_agg(_t), '[]'::json) AS body FROM (SELECT _f.* FROM ${source} LIMIT ${DB_MAX_ROWS}) _t`, values: params.values };
  }
  if (fn.returnsVoid) {
    return { text: from ? `SELECT ${call} FROM ${from}` : `SELECT ${call}`, values: params.values, void: true };
  }
  const value = fn.returnsRows ? `to_json(_f)` : `to_json(_f._v)`;
  const target = fn.returnsRows ? `${call} AS _f` : `(SELECT ${call} AS _v) AS _f`;
  return { text: `SELECT ${value} AS body FROM ${from ? `${from}, LATERAL ` : ''}${target}`, values: params.values };
}

/**
 * The overload of `name` that takes these arguments: every name passed is one
 * of its inputs and every input without a default is passed. PostgREST picks by
 * argument names the same way.
 */
export function pickFunction(candidates, name, argNames) {
  const given = new Set(argNames);
  const fits = candidates.filter((fn) => {
    const inputs = Object.keys(fn.argTypes);
    return argNames.every((arg) => inputs.includes(arg)) && fn.required.every((arg) => given.has(arg));
  });
  if (fits.length !== 1) {
    throw new Error(`rpc ${name}: ${fits.length === 0 ? 'no function' : 'more than one function'} takes (${argNames.join(', ')})`);
  }
  return fits[0];
}
