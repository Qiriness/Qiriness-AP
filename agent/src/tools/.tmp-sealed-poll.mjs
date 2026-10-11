// SEALED POLL of the real worker: Supabase GETs are real; every Supabase write or
// RPC is answered with a fake success; Graph is an empty mailbox; anything else
// (OpenAI, Shopify) throws. Counts the bytes each poll downloads, by table.
const realFetch = globalThis.fetch;
const polls = [];
let current = null;
const seen = { writes: 0, blocked: new Set() };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.hostname.endsWith('.supabase.co')) {
    const path = url.pathname.replace('/rest/v1/', '');
    if (method !== 'GET' || path.startsWith('rpc/')) {
      seen.writes += 1;
      if (current) (current.writes ??= []).push(`${method} ${path.split('?')[0]} ${/return=representation/.test(String(init.headers?.Prefer ?? '')) ? 'REPR' : (init.headers?.Prefer ?? '-')}`);
      return method === 'POST' && !path.startsWith('rpc/') && /return=representation/.test(String(init.headers?.Prefer ?? ''))
        ? json(JSON.parse(init.body ?? '[]'), 201)
        : json([], 200);
    }
    if (path === 'agent_models') { current = { at: new Date().toISOString(), bytes: 0, requests: 0, byTable: {} }; polls.push(current); }
    const response = await realFetch(input, init);
    const text = await response.text();
    if (current) {
      const size = Buffer.byteLength(text);
      current.bytes += size; current.requests += 1;
      current.byTable[path] = (current.byTable[path] ?? 0) + size;
    }
    return new Response(text, { status: response.status, headers: response.headers });
  }
  if (url.hostname === 'login.microsoftonline.com') return json({ access_token: 'sealed', expires_in: 3600, token_type: 'Bearer' });
  if (url.hostname === 'graph.microsoft.com') {
    return method === 'GET' ? json({ value: [], '@odata.deltaLink': `${url.origin}${url.pathname}?$deltatoken=sealed` }) : json({}, 202);
  }
  seen.blocked.add(url.hostname);
  throw new Error(`sealed: ${url.hostname}`);
};

const report = () => {
  for (const [i, p] of polls.entries()) {
    const top = Object.entries(p.byTable).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, b]) => `${t} ${(b / 1024).toFixed(1)}`).join(' · ');
    console.error('  writes:', JSON.stringify(p.writes ?? []));
    console.error(`POLL ${i + 1} ${p.at} ${(p.bytes / 1024).toFixed(1)} kB in ${p.requests} requests | ${top}`);
  }
  console.error('fake writes:', seen.writes, 'blocked hosts:', [...seen.blocked].join(',') || 'none');
};
setTimeout(() => { report(); process.exit(0); }, Number(process.env.SEALED_SECONDS ?? 100) * 1000).unref();
