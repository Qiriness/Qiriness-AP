/**
 * The app's schema, read from a live catalogue: as DDL (the baseline) and as a
 * comparable description (to prove a database built from that DDL is the same).
 *
 * WHY BOTH FROM ONE PLACE. The baseline is generated from production rather than
 * written by hand, and it is trusted only because a database built from it is
 * described identically to production. Generating and describing through the
 * same catalogue functions (pg_get_functiondef, pg_get_viewdef,
 * pg_get_constraintdef, pg_get_indexdef, pg_get_triggerdef, format_type,
 * pg_get_expr) means the comparison checks the DDL, not two renderers.
 *
 * SCOPE. Schemas `public` and `chat`, minus objects that belong to extensions;
 * the extensions themselves; the chat role. Not auth / storage / vault internals
 * (Supabase provides them), not data.
 *
 * Every query runs with search_path = '' so every name prints schema-qualified,
 * and the generated file runs the same whatever the caller's path.
 */

export const SCHEMAS = ['public', 'chat'];
const IN_SCOPE = `n.nspname in ('public', 'chat')`;
const NOT_EXTENSION = (oid) => `not exists (select 1 from pg_depend d where d.objid = ${oid} and d.deptype = 'e')`;

/** The extensions the app needs, and where they live (as on Supabase). */
export const EXTENSIONS = [
  ['pgcrypto', 'extensions'],
  ['uuid-ossp', 'extensions'],
  ['vector', 'public'],
  ['unaccent', 'public'],
  ['supabase_vault', 'vault']
];

/** The management chat's role: attributes here, settings read from the catalogue. Its password is the operator's. */
export const CHAT_ROLE = 'mgmt_chat_ro';
/**
 * The worker's and the nightly's login role for the direct connection (migration
 * direct_worker_connection): no rights of its own, a member of `service_role`, which each connection
 * switches to. Its password is the operator's (scripts/set-worker-db-password.mjs).
 */
export const WORKER_ROLE = 'qiriness_worker';
const APP_ROLES = ['anon', 'authenticated', 'service_role', CHAT_ROLE];

async function rows(client, sql, params) {
  return (await client.query(sql, params)).rows;
}

async function readCatalog(client) {
  await client.query(`set search_path = ''`);
  const tables = await rows(client, `
    select c.oid, n.nspname as schema, c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
      coalesce(c.relacl, acldefault('r', c.relowner))::text[] as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ${IN_SCOPE} and c.relkind in ('r', 'p') and ${NOT_EXTENSION('c.oid')}
    order by n.nspname, c.relname`);
  const columns = await rows(client, `
    select a.attrelid as table_oid, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
      a.attgenerated as generated, a.attidentity as identity,
      case when a.attcollation <> t.typcollation and a.attcollation <> 0 then (select collname from pg_collation where oid = a.attcollation) end as collation,
      pg_get_expr(ad.adbin, ad.adrelid) as expr
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where ${IN_SCOPE} and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
    order by a.attrelid, a.attnum`);
  const constraints = await rows(client, `
    select co.conrelid as table_oid, co.conname as name, co.contype as type, pg_get_constraintdef(co.oid) as def
    from pg_constraint co join pg_class c on c.oid = co.conrelid join pg_namespace n on n.oid = c.relnamespace
    where ${IN_SCOPE} and c.relkind in ('r', 'p') and co.contype in ('p', 'u', 'c', 'f', 'x')
    order by co.conrelid, co.contype, co.conname`);
  const indexes = await rows(client, `
    select n.nspname as schema, ic.relname as name, tc.relname as table_name, pg_get_indexdef(i.indexrelid) as def
    from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class tc on tc.oid = i.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    where ${IN_SCOPE} and not exists (select 1 from pg_constraint co where co.conindid = i.indexrelid and co.conrelid = i.indrelid and co.contype in ('p', 'u', 'x'))
      and ${NOT_EXTENSION('ic.oid')}
    order by tc.relname, ic.relname`);
  const views = await rows(client, `
    select c.oid, n.nspname as schema, c.relname as name, pg_get_viewdef(c.oid, true) as def,
      coalesce(c.reloptions, '{}') as options, coalesce(c.relacl, acldefault('r', c.relowner))::text[] as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ${IN_SCOPE} and c.relkind = 'v' and ${NOT_EXTENSION('c.oid')}
    order by n.nspname, c.relname`);
  const viewColumns = await rows(client, `
    select a.attrelid as view_oid, a.attname as name, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where ${IN_SCOPE} and c.relkind = 'v' and a.attnum > 0 and not a.attisdropped
    order by a.attrelid, a.attnum`);
  const viewDeps = await rows(client, `
    select distinct r.ev_class as view_oid, d.refobjid as dep_oid
    from pg_rewrite r join pg_depend d on d.objid = r.oid and d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
    where d.refobjid <> r.ev_class`);
  const functions = await rows(client, `
    select p.oid, n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
      pg_get_functiondef(p.oid) as def, coalesce(p.proacl, acldefault('f', p.proowner))::text[] as acl,
      exists (select 1 from pg_type t where t.typrelid <> 0 and (t.oid = p.prorettype or t.oid = any(p.proargtypes::oid[]))) as uses_rowtype
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ${IN_SCOPE} and p.prokind = 'f' and ${NOT_EXTENSION('p.oid')}
    order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`);
  const triggers = await rows(client, `
    select tc.relname as table_name, t.tgname as name, pg_get_triggerdef(t.oid) as def
    from pg_trigger t join pg_class tc on tc.oid = t.tgrelid join pg_namespace n on n.oid = tc.relnamespace
    where ${IN_SCOPE} and not t.tgisinternal
    order by tc.relname, t.tgname`);
  const comments = await rows(client, `
    select 'table' as kind, n.nspname || '.' || c.relname as target, null::text as on_table, d.description as text,
      case c.relkind when 'v' then 'view' when 'i' then 'index' else 'table' end as relkind, null::text as column_name
    from pg_description d join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass and d.objsubid = 0
    join pg_namespace n on n.oid = c.relnamespace where ${IN_SCOPE}
    union all
    select 'column', n.nspname || '.' || c.relname, null, d.description, null, a.attname
    from pg_description d join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass and d.objsubid > 0
    join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid
    join pg_namespace n on n.oid = c.relnamespace where ${IN_SCOPE}
    union all
    select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', null, d.description, null, null
    from pg_description d join pg_proc p on p.oid = d.objoid and d.classoid = 'pg_proc'::regclass
    join pg_namespace n on n.oid = p.pronamespace where ${IN_SCOPE} and ${NOT_EXTENSION('p.oid')}
    union all
    select 'constraint', co.conname, n.nspname || '.' || c.relname, d.description, null, null
    from pg_description d join pg_constraint co on co.oid = d.objoid and d.classoid = 'pg_constraint'::regclass
    join pg_class c on c.oid = co.conrelid join pg_namespace n on n.oid = c.relnamespace where ${IN_SCOPE}
    union all
    select 'trigger', t.tgname, n.nspname || '.' || c.relname, d.description, null, null
    from pg_description d join pg_trigger t on t.oid = d.objoid and d.classoid = 'pg_trigger'::regclass
    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where ${IN_SCOPE}
    union all
    select 'schema', n.nspname, null, d.description, null, null
    from pg_description d join pg_namespace n on n.oid = d.objoid and d.classoid = 'pg_namespace'::regclass where n.nspname = 'chat'
    order by 1, 2, 6`);
  const textSearch = await rows(client, `
    select n.nspname as schema, c.cfgname as name, p.prsnamespace::regnamespace::text || '.' || p.prsname as parser,
      coalesce((select json_agg(json_build_object('token', tt.alias, 'dicts', d.dicts) order by tt.alias)
        from (select m.maptokentype, string_agg(m.mapdict::regdictionary::text, ', ' order by m.mapseqno) as dicts
              from pg_ts_config_map m where m.mapcfg = c.oid group by m.maptokentype) d
        join ts_token_type(c.cfgparser) tt on tt.tokid = d.maptokentype), '[]') as mappings
    from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace join pg_ts_parser p on p.oid = c.cfgparser
    where ${IN_SCOPE} and ${NOT_EXTENSION('c.oid')}
    order by n.nspname, c.cfgname`);
  const chatSchema = (await rows(client, `select nspacl::text[] as acl from pg_namespace where nspname = 'chat'`))[0] ?? null;
  const role = (await rows(client, `select rolcanlogin, rolinherit, rolconnlimit, coalesce(rolconfig, '{}') as config, rolbypassrls
    from pg_roles where rolname = $1`, [CHAT_ROLE]))[0] ?? null;
  const workerRole = (await rows(client, `select r.rolcanlogin, r.rolinherit, r.rolconnlimit, coalesce(r.rolconfig, '{}') as config,
      array(select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid order by 1)::text[] as member_of
    from pg_roles r where r.rolname = $1`, [WORKER_ROLE]))[0] ?? null;
  return { tables, columns, constraints, indexes, views, viewColumns, viewDeps, functions, triggers, comments, textSearch, chatSchema, role, workerRole };
}

/** An ACL as {grantee: sorted privilege letters}, the owner and grantors dropped. */
function aclMap(acl) {
  const out = {};
  for (const item of acl || []) {
    const m = String(item).match(/^"?([^=]*?)"?=([a-zA-Z*]*)\//);
    if (!m) continue;
    const grantee = m[1] || 'PUBLIC';
    if (grantee === 'postgres' || grantee === 'supabase_admin') continue;
    const privs = m[2].replace(/\*/g, '').split('').sort().join('');
    if (privs) out[grantee] = privs;
  }
  return Object.fromEntries(Object.entries(out).sort());
}

const TABLE_PRIVS = { a: 'insert', r: 'select', w: 'update', d: 'delete', D: 'truncate', x: 'references', t: 'trigger', m: 'maintain' };
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`);

function grantsFor(kind, target, acl) {
  const map = aclMap(acl);
  const lines = [`revoke all on ${kind === 'function' ? 'function ' : ''}${target} from public, ${APP_ROLES.join(', ')};`];
  for (const [grantee, privs] of Object.entries(map)) {
    const who = grantee === 'PUBLIC' ? 'public' : ident(grantee);
    if (kind === 'function') { if (privs.includes('X')) lines.push(`grant execute on function ${target} to ${who};`); continue; }
    const names = privs.split('').map((p) => TABLE_PRIVS[p]).filter(Boolean);
    if (names.length) lines.push(`grant ${names.join(', ')} on ${target} to ${who};`);
  }
  return lines;
}

/** Views ordered so each comes after every view it reads. */
function orderViews(views, deps) {
  const byOid = new Map(views.map((v) => [String(v.oid), v]));
  const needs = new Map(views.map((v) => [String(v.oid), new Set()]));
  for (const d of deps) if (byOid.has(String(d.view_oid)) && byOid.has(String(d.dep_oid))) needs.get(String(d.view_oid)).add(String(d.dep_oid));
  const done = new Set(), out = [];
  const visit = (oid, path = new Set()) => {
    if (done.has(oid)) return;
    if (path.has(oid)) throw new Error(`view dependency cycle at ${byOid.get(oid).name}`);
    path.add(oid);
    for (const dep of needs.get(oid)) visit(dep, path);
    done.add(oid); out.push(byOid.get(oid));
  };
  for (const v of views) visit(String(v.oid));
  return out;
}

export async function generateBaseline(client, { header = '' } = {}) {
  const cat = await readCatalog(client);
  const out = [];
  const section = (title) => out.push('', `-- ${'='.repeat(76)}`, `-- ${title}`, `-- ${'='.repeat(76)}`, '');
  out.push(header.trimEnd(), '', `set check_function_bodies = off;`, `set client_min_messages = warning;`);

  section('EXTENSIONS AND ROLES');
  out.push(`create schema if not exists extensions;`);
  for (const [name, schema] of EXTENSIONS) out.push(`create extension if not exists ${ident(name)} with schema ${schema};`);
  if (cat.role) {
    const r = cat.role;
    out.push('', `do $$`, `begin`, `  if not exists (select 1 from pg_roles where rolname = ${literal(CHAT_ROLE)}) then`,
      `    create role ${CHAT_ROLE} ${r.rolcanlogin ? 'login' : 'nologin'} ${r.rolinherit ? 'inherit' : 'noinherit'} connection limit ${r.rolconnlimit};`,
      `  end if;`, `end`, `$$;`,
      `-- The password is set by the operator: alter role ${CHAT_ROLE} password '…'; (CHAT_DB_URL)`);
    for (const setting of r.config) {
      const [k, ...v] = setting.split('=');
      out.push(`alter role ${CHAT_ROLE} set ${k} = ${literal(v.join('='))};`);
    }
  }
  if (cat.workerRole) {
    const r = cat.workerRole;
    out.push('', `do $$`, `begin`, `  if not exists (select 1 from pg_roles where rolname = ${literal(WORKER_ROLE)}) then`,
      `    create role ${WORKER_ROLE} ${r.rolcanlogin ? 'login' : 'nologin'} ${r.rolinherit ? 'inherit' : 'noinherit'} connection limit ${r.rolconnlimit};`,
      `  end if;`, `end`, `$$;`,
      `-- The password is set by the operator: node scripts/set-worker-db-password.mjs (WORKER_DB_URL)`);
    for (const group of r.member_of) out.push(`grant ${ident(group)} to ${WORKER_ROLE};`);
    for (const setting of r.config) {
      const [k, ...v] = setting.split('=');
      // A list setting is written as Postgres stores it: quoted whole,
      // 'public, extensions' would be ONE schema of that name.
      out.push(`alter role ${WORKER_ROLE} set ${k} = ${k === 'search_path' ? v.join('=') : literal(v.join('='))};`);
    }
  }
  out.push('', `create schema if not exists chat;`);

  section('TEXT SEARCH (before the tables: generated search columns use it)');
  for (const ts of cat.textSearch) {
    out.push(`create text search configuration ${ts.schema}.${ident(ts.name)} (parser = ${ts.parser});`);
    for (const m of ts.mappings) out.push(`alter text search configuration ${ts.schema}.${ident(ts.name)} add mapping for ${m.token} with ${m.dicts};`);
    out.push('');
  }

  section('FUNCTIONS (bodies are not checked at creation; see check_function_bodies above)');
  for (const f of cat.functions.filter((f) => !f.uses_rowtype)) out.push(`${f.def.trim()};`, '');

  section('TABLES (foreign keys are added after every table exists)');
  const colsBy = new Map(); for (const c of cat.columns) (colsBy.get(String(c.table_oid)) ?? colsBy.set(String(c.table_oid), []).get(String(c.table_oid))).push(c);
  const consBy = new Map(); for (const c of cat.constraints) (consBy.get(String(c.table_oid)) ?? consBy.set(String(c.table_oid), []).get(String(c.table_oid))).push(c);
  const fks = [];
  for (const t of cat.tables) {
    const parts = (colsBy.get(String(t.oid)) || []).map((c) => {
      let line = `  ${ident(c.name)} ${c.type}`;
      if (c.collation) line += ` collate ${ident(c.collation)}`;
      if (c.generated === 's') line += ` generated always as (${c.expr}) stored`;
      else if (c.identity) line += ` generated ${c.identity === 'a' ? 'always' : 'by default'} as identity`;
      else if (c.expr !== null) line += ` default ${c.expr}`;
      if (c.not_null) line += ' not null';
      return line;
    });
    for (const co of consBy.get(String(t.oid)) || []) {
      if (co.type === 'f') fks.push(`alter table ${t.schema}.${ident(t.name)} add constraint ${ident(co.name)} ${co.def};`);
      else parts.push(`  constraint ${ident(co.name)} ${co.def}`);
    }
    out.push(`create table ${t.schema}.${ident(t.name)} (`, parts.join(',\n'), `);`, '');
  }

  section('VIEWS (each after the views it reads)');
  for (const v of orderViews(cat.views, cat.viewDeps)) {
    const opts = v.options.length ? ` with (${v.options.join(', ')})` : '';
    out.push(`create view ${v.schema}.${ident(v.name)}${opts} as`, v.def.trim().replace(/;?$/, ';'), '');
  }

  section('FUNCTIONS THAT TAKE OR RETURN A TABLE OR VIEW ROW (after both exist)');
  for (const f of cat.functions.filter((f) => f.uses_rowtype)) out.push(`${f.def.trim()};`, '');

  section('INDEXES');
  out.push(...cat.indexes.map((i) => `${i.def};`));

  section('FOREIGN KEYS (after the indexes: some reference a unique index, not a constraint)');
  out.push(...fks);

  section('TRIGGERS');
  out.push(...cat.triggers.map((t) => `${t.def};`));

  section('ROW LEVEL SECURITY (enabled, no policies: service role only)');
  for (const t of cat.tables) {
    if (t.rls) out.push(`alter table ${t.schema}.${ident(t.name)} enable row level security;`);
    if (t.force_rls) out.push(`alter table ${t.schema}.${ident(t.name)} force row level security;`);
  }

  section('PRIVILEGES (exactly as in production; revoked first, so platform defaults cannot add to them)');
  if (cat.chatSchema) {
    out.push(`revoke all on schema chat from public, ${APP_ROLES.join(', ')};`);
    for (const [grantee, privs] of Object.entries(aclMap(cat.chatSchema.acl))) {
      const names = privs.split('').map((p) => ({ U: 'usage', C: 'create' })[p]).filter(Boolean);
      if (names.length) out.push(`grant ${names.join(', ')} on schema chat to ${ident(grantee)};`);
    }
  }
  for (const t of cat.tables) out.push(...grantsFor('table', `${t.schema}.${ident(t.name)}`, t.acl));
  for (const v of cat.views) out.push(...grantsFor('table', `${v.schema}.${ident(v.name)}`, v.acl));
  for (const f of cat.functions) out.push(...grantsFor('function', `${f.schema}.${ident(f.name)}(${f.args})`, f.acl));

  section('COMMENTS');
  for (const c of cat.comments) {
    if (c.kind === 'table') out.push(`comment on ${c.relkind} ${c.target} is ${literal(c.text)};`);
    else if (c.kind === 'column') out.push(`comment on column ${c.target}.${ident(c.column_name)} is ${literal(c.text)};`);
    else if (c.kind === 'function') out.push(`comment on function ${c.target} is ${literal(c.text)};`);
    else if (c.kind === 'constraint') out.push(`comment on constraint ${ident(c.target)} on ${c.on_table} is ${literal(c.text)};`);
    else if (c.kind === 'trigger') out.push(`comment on trigger ${ident(c.target)} on ${c.on_table} is ${literal(c.text)};`);
    else if (c.kind === 'schema') out.push(`comment on schema ${ident(c.target)} is ${literal(c.text)};`);
  }

  out.push('', `reset check_function_bodies;`, `reset client_min_messages;`, '');
  return out.join('\n');
}

/** A comparable description: what must be equal between production and a database built from the baseline. */
export async function describeCatalog(client) {
  const cat = await readCatalog(client);
  return {
    tables: Object.fromEntries(cat.tables.map((t) => [`${t.schema}.${t.name}`, {
      rls: t.rls, force_rls: t.force_rls, acl: aclMap(t.acl),
      columns: cat.columns.filter((c) => String(c.table_oid) === String(t.oid))
        .map((c) => `${c.name} ${c.type}${c.collation ? ` collate ${c.collation}` : ''}${c.not_null ? ' not null' : ''}${c.generated ? ` generated(${c.expr})` : c.expr !== null ? ` default ${c.expr}` : ''}${c.identity ? ` identity ${c.identity}` : ''}`),
      constraints: cat.constraints.filter((c) => String(c.table_oid) === String(t.oid)).map((c) => `${c.name}: ${c.def}`).sort()
    }])),
    indexes: cat.indexes.map((i) => i.def).sort(),
    views: Object.fromEntries(cat.views.map((v) => [`${v.schema}.${v.name}`, {
      columns: cat.viewColumns.filter((c) => String(c.view_oid) === String(v.oid)).map((c) => `${c.name} ${c.type}`),
      def: v.def, options: [...v.options].sort(), acl: aclMap(v.acl)
    }])),
    functions: Object.fromEntries(cat.functions.map((f) => [`${f.schema}.${f.name}(${f.args})`, { def: f.def, acl: aclMap(f.acl) }])),
    triggers: cat.triggers.map((t) => t.def).sort(),
    comments: cat.comments.map((c) => `${c.kind} ${c.target}${c.column_name ? `.${c.column_name}` : ''}${c.on_table ? ` on ${c.on_table}` : ''}: ${c.text}`).sort(),
    textSearch: cat.textSearch.map((ts) => `${ts.schema}.${ts.name} [${ts.parser}] ${ts.mappings.map((m) => `${m.token}:${m.dicts}`).join(' ')}`),
    chatSchemaAcl: cat.chatSchema ? aclMap(cat.chatSchema.acl) : null,
    chatRole: cat.role ? { ...cat.role, config: [...cat.role.config].sort() } : null,
    workerRole: cat.workerRole ? { ...cat.workerRole, config: [...cat.workerRole.config].sort(), member_of: [...cat.workerRole.member_of].sort() } : null,
  };
}

/** Paths at which two descriptions differ. Pure. */
export function diffCatalogs(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffCatalogs(a[k], b[k], at ? `${at}.${k}` : k));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const onlyA = a.filter((x) => !b.some((y) => JSON.stringify(y) === JSON.stringify(x)));
    const onlyB = b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)));
    if (!onlyA.length && !onlyB.length) return [`${at}: same items, different order`];
    return [...onlyA.map((x) => `${at}: only in first: ${JSON.stringify(x).slice(0, 200)}`), ...onlyB.map((x) => `${at}: only in second: ${JSON.stringify(x).slice(0, 200)}`)];
  }
  return [`${at}: ${JSON.stringify(a)?.slice(0, 150)} != ${JSON.stringify(b)?.slice(0, 150)}`];
}
