import { randomUUID } from 'node:crypto';

// A PostgREST-shaped transport backed by objects in memory.
//
// WHY THIS AND NOT A SECOND TICKET RECORD. The rehearsal has to run the passes
// without writing rows, and the obvious way to get there is a second
// implementation of `ticket-record.mjs` — the claim filters, the flag protocol,
// the metadata trail — that only the test chat uses. That module is documented
// as THE ONLY WRITER OF `tickets`, and a second copy of its rules is a second
// place for them to be wrong: the rehearsal would keep working while the worker
// changed underneath it, which is the one failure a rehearsal cannot survive.
//
// `createTicketRecord` and `createDraftRecord` both already take their
// PostgREST calls as an injectable `transport`, for their own unit tests. So the
// substitution happens one layer lower: this fakes the DATABASE, and the real
// records run on top of it, unmodified and unaware. Every filter, every
// projection, every flag transition in a rehearsal is the worker's own code.
//
// IT IMPLEMENTS ONLY THE OPERATORS THE PASSES USE, and throws on anything else.
// A silent "no rows" for an operator this does not understand would look exactly
// like an empty queue — a pass that quietly did nothing, in a tool whose whole
// job is to show what the passes did. Failing loudly means a new filter in a
// pass is a test failure here rather than a rehearsal that skips a step.

/** Operators this transport understands. Anything else is a hard error. */
const OPERATORS = new Set(['is', 'not.is', 'in', 'not.in', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte']);

/**
 * @param seed  `{ [table]: rows[] }`. Rows are copied, so the caller's fixtures
 *              are not mutated by a pass that patches a ticket.
 */
export function createMemoryTransport(seed = {}) {
  const tables = new Map(
    Object.entries(seed).map(([table, rows]) => [table, (rows || []).map((row) => ({ ...row }))])
  );

  const table = (name) => {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name);
  };

  const read = (name, filters, columns, options = {}) => {
    let rows = table(name).filter((row) => matches(row, filters));
    if (options.order) {
      rows = sortRows(rows, options.order);
    }
    if (typeof options.limit === 'number') {
      rows = rows.slice(0, options.limit);
    }
    return rows.map((row) => project(row, columns));
  };

  return {
    /** The tables, for a caller that wants to read what a pass wrote. */
    tables,
    rows: (name) => table(name).map((row) => ({ ...row })),

    select: async (_client, name, filters, columns, options) =>
      read(name, filters, columns, options),

    // No paging to emulate: the whole "database" is a handful of rows.
    selectAll: async (_client, name, filters, columns, options) =>
      read(name, filters, columns, options),

    insert: async (_client, name, rows) => {
      const written = rows.map((row) => ({ id: randomUUID(), ...row }));
      table(name).push(...written);
      return written.map((row) => ({ ...row }));
    },

    update: async (_client, name, filters, columns) => {
      const hit = table(name).filter((row) => matches(row, filters));
      for (const row of hit) {
        Object.assign(row, columns);
      }
      return hit.map((row) => ({ ...row }));
    },

    updateById: async (_client, name, id, columns) => {
      const row = table(name).find((candidate) => candidate.id === id);
      if (!row) {
        // The real transport would PATCH nothing and return nothing; here it
        // means the rehearsal seeded the wrong id, which is a bug in the harness
        // rather than a state a pass should tolerate.
        throw new Error(`memory transport: no row ${id} in ${name}`);
      }
      Object.assign(row, columns);
      return { ...row };
    },

    /**
     * Merge-duplicates on the conflict columns, which is what
     * `Prefer: resolution=merge-duplicates` does — and the reason the case-file
     * store's idempotency key behaves in a rehearsal exactly as it does live.
     */
    upsert: async (_client, name, rows, onConflict) => {
      const keys = String(onConflict || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
      const written = [];
      for (const incoming of rows) {
        const existing =
          keys.length > 0
            ? table(name).find((row) => keys.every((key) => row[key] === incoming[key]))
            : undefined;
        if (existing) {
          Object.assign(existing, incoming);
          written.push({ ...existing });
        } else {
          const row = { id: randomUUID(), ...incoming };
          table(name).push(row);
          written.push({ ...row });
        }
      }
      return written;
    }
  };
}

function matches(row, filters = {}) {
  return Object.entries(filters).every(([column, condition]) => {
    if (condition === null || typeof condition !== 'object') {
      return row[column] === condition;
    }
    const { operator, value } = condition;
    if (!OPERATORS.has(operator)) {
      throw new Error(
        `memory transport: filter operator "${operator}" is not implemented. ` +
          'Add it here rather than letting the pass silently match nothing.'
      );
    }
    const actual = row[column];
    switch (operator) {
      case 'is':
        if (value === 'null') return actual === null || actual === undefined;
        if (value === 'true') return actual === true;
        if (value === 'false') return actual === false || actual === null || actual === undefined;
        throw new Error(`memory transport: unsupported is.${value}`);
      case 'not.is':
        if (value === 'null') return actual !== null && actual !== undefined;
        throw new Error(`memory transport: unsupported not.is.${value}`);
      case 'in':
        return listOf(value).includes(String(actual));
      case 'not.in':
        return !listOf(value).includes(String(actual));
      case 'eq':
        return actual === value;
      case 'neq':
        return actual !== value;
      case 'lt':
        return actual !== null && actual !== undefined && actual < value;
      case 'lte':
        return actual !== null && actual !== undefined && actual <= value;
      case 'gt':
        return actual !== null && actual !== undefined && actual > value;
      case 'gte':
        return actual !== null && actual !== undefined && actual >= value;
      default:
        return false;
    }
  });
}

/** `(a,b,"#1006")` -> ['a', 'b', '#1006'] */
function listOf(value) {
  return String(value)
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"'))
    .filter((item) => item !== '');
}

function sortRows(rows, order) {
  const [column, direction = 'asc'] = String(order).split('.');
  const sign = direction.startsWith('desc') ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = a[column];
    const right = b[column];
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return left < right ? -sign : sign;
  });
}

/**
 * The projection, honoured rather than ignored.
 *
 * Returning the whole row would be easier and would hide a real class of bug: a
 * pass that reads a column its projection does not select works in a rehearsal
 * and fails against PostgREST, which is precisely backwards.
 */
function project(row, columns) {
  if (!columns || columns === '*') {
    return { ...row };
  }
  if (columns.includes('(')) {
    // PostgREST embeds resolve over a foreign key. No pass in a rehearsal uses
    // one; implementing it silently would be inventing a join.
    throw new Error(`memory transport: embedded selects are not implemented (${columns})`);
  }
  const picked = {};
  for (const column of columns.split(',').map((name) => name.trim()).filter(Boolean)) {
    picked[column] = row[column] ?? null;
  }
  return picked;
}
