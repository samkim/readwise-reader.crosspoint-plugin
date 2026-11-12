import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const PLUGIN = new URL('../readwise-reader.crosspoint-plugin/plugin.js', import.meta.url);
const GOOD_TOKEN = 'AbCdEf0123456789AbCdEf0123456789AbCdEf01';
const DIR = '/.crosspoint/plugins/readwise-reader';

async function loadPlugin() {
  const hooks = {};
  let registered = null;
  const context = vm.createContext({
    __readwiseReaderTest: hooks,
    CrossPoint: { registerPlugin(fn) { registered = fn; } },
    TextEncoder, btoa, atob, JSON, Promise, Object, String, Error,
    fetch: () => { throw new Error('real fetch must not be used in tests'); },
  });
  vm.runInContext(await readFile(PLUGIN, 'utf8'), context, { filename: 'plugin.js' });
  assert.equal(typeof registered, 'function', 'plugin.js registers a render function');
  return hooks;
}

// A fake of the firmware's plugin api. `responses` maps URL -> {status, body}
// or a function returning one; `files` is the SD card.
function fakeApi({ responses = {}, files = {}, dir = DIR } = {}) {
  const calls = [];
  return {
    name: 'readwise-reader',
    dir,
    calls,
    files,
    async relay(method, url, headers, body) {
      // JSON round trip: objects created inside the vm context have another realm's prototype.
      calls.push(JSON.parse(JSON.stringify({ method, url, headers, body })));
      const r = responses[url];
      if (!r) throw new Error('no fake response for ' + url);
      return typeof r === 'function' ? r() : { headers: [], body: '', ...r };
    },
    async writeFile(path, dataB64) {
      files[path] = Buffer.from(dataB64, 'base64').toString('utf8');
      return { ok: true, bytes: files[path].length };
    },
  };
}

function fakeFetch(api) {
  return async (url) => {
    const path = decodeURIComponent(url.replace('/download?path=', ''));
    if (!(path in api.files)) return { ok: false, status: 404, text: async () => 'Item not found' };
    return { ok: true, status: 200, text: async () => api.files[path] };
  };
}

// Just enough DOM for render(): elements are found by the ids in innerHTML.
function fakeContainer() {
  const elements = {};
  return {
    elements,
    set innerHTML(html) {
      for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
        elements[id] = { id, value: '', textContent: '', disabled: false, style: { display: '' }, onclick: null };
      }
    },
    querySelector(selector) {
      return elements[selector.replace(/^#/, '')] || null;
    },
  };
}

const AUTH = 'https://readwise.io/api/v2/auth/';
const COUNT = 'https://readwise.io/api/v3/list/?category=epub&limit=1';

test('normalizeToken accepts plain and "Token "-prefixed tokens and rejects junk', async () => {
  const p = await loadPlugin();
  assert.equal(p.normalizeToken('  ' + GOOD_TOKEN + '\n'), GOOD_TOKEN);
  assert.equal(p.normalizeToken('Token ' + GOOD_TOKEN), GOOD_TOKEN);
  for (const bad of ['', null, undefined, 'short', 'has space inside token value', 'https://readwise.io/access_token', GOOD_TOKEN + '"}']) {
    assert.equal(p.normalizeToken(bad), '', `rejects ${JSON.stringify(bad)}`);
  }
});

test('configPath uses the installed plugin dir, with a fallback', async () => {
  const p = await loadPlugin();
  assert.equal(p.configPath({ dir: '/plugins/readwise-reader/' }), '/plugins/readwise-reader/config.json');
  assert.equal(p.configPath({ name: 'readwise-reader' }), DIR + '/config.json');
});

test('connect validates the token with Readwise, then writes config.json', async () => {
  const p = await loadPlugin();
  const api = fakeApi({ responses: { [AUTH]: { status: 204 } } });
  const result = await p.connect(api, 'Token ' + GOOD_TOKEN);
  assert.equal(result.ok, true);
  assert.deepEqual(api.calls[0], { method: 'GET', url: AUTH, headers: { Authorization: 'Token ' + GOOD_TOKEN }, body: '' });
  assert.deepEqual(JSON.parse(api.files[DIR + '/config.json']), { token: GOOD_TOKEN });
});

test('connect does not write anything for a rejected, rate-limited or unreachable token check', async () => {
  const p = await loadPlugin();
  const cases = [
    [{ status: 401 }, /did not accept/],
    [{ status: 429 }, /rate limit/],
    [{ status: 500 }, /HTTP 500/],
    [() => { throw new Error('/api/relay 502: relay failed'); }, /Could not reach Readwise/],
  ];
  for (const [response, message] of cases) {
    const api = fakeApi({ responses: { [AUTH]: response } });
    const result = await p.connect(api, GOOD_TOKEN);
    assert.equal(result.ok, false);
    assert.match(result.message, message);
    assert.deepEqual(api.files, {}, 'nothing written');
  }
});

test('connect rejects a malformed token without any request', async () => {
  const p = await loadPlugin();
  const api = fakeApi();
  const result = await p.connect(api, 'not a token');
  assert.equal(result.ok, false);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(api.files, {});
});

test('connect reports a failed SD write', async () => {
  const p = await loadPlugin();
  const api = fakeApi({ responses: { [AUTH]: { status: 204 } } });
  api.writeFile = async () => { throw new Error('/api/plugin-fs 403: plugin system disabled'); };
  const result = await p.connect(api, GOOD_TOKEN);
  assert.equal(result.ok, false);
  assert.match(result.message, /Could not save the token: .*plugin system disabled/);
});

test('disconnect replaces config.json with an empty object, which the firmware treats as signed out', async () => {
  const p = await loadPlugin();
  const api = fakeApi({ files: { [DIR + '/config.json']: JSON.stringify({ token: GOOD_TOKEN }) } });
  await p.disconnect(api);
  assert.deepEqual(JSON.parse(api.files[DIR + '/config.json']), {});
});

test('readConfig tolerates a missing or corrupt file', async () => {
  const p = await loadPlugin();
  const missing = fakeApi();
  assert.deepEqual({ ...(await p.readConfig(missing, fakeFetch(missing))) }, {});
  const corrupt = fakeApi({ files: { [DIR + '/config.json']: '{nope' } });
  assert.deepEqual({ ...(await p.readConfig(corrupt, fakeFetch(corrupt))) }, {});
});

test('countEpubs reads count and returns null on failure', async () => {
  const p = await loadPlugin();
  assert.equal(await p.countEpubs(fakeApi({ responses: { [COUNT]: { status: 200, body: '{"count": 7, "results": []}' } } }), GOOD_TOKEN), 7);
  assert.equal(await p.countEpubs(fakeApi({ responses: { [COUNT]: { status: 401 } } }), GOOD_TOKEN), null);
  assert.equal(await p.countEpubs(fakeApi({ responses: { [COUNT]: { status: 200, body: 'not json' } } }), GOOD_TOKEN), null);
  assert.equal(p.connectedText(1).startsWith('Connected. 1 EPUB in'), true);
  assert.equal(p.connectedText(null).startsWith('Connected. On the reader'), true);
});

test('UTF-8 base64 round trip', async () => {
  const p = await loadPlugin();
  assert.equal(Buffer.from(p.encodeBase64Utf8('{"a":"é✓"}'), 'base64').toString('utf8'), '{"a":"é✓"}');
});

test('settings card: not connected -> Connect -> connected -> Disconnect', async () => {
  const p = await loadPlugin();
  const api = fakeApi({ responses: { [AUTH]: { status: 204 }, [COUNT]: { status: 200, body: '{"count": 3}' } } });
  const c = fakeContainer();
  await p.render(c, api, fakeFetch(api));
  const el = (id) => c.elements['rwr-' + id];
  assert.equal(el('status').textContent, 'Not connected.');
  assert.equal(el('signin').style.display, '');
  assert.equal(el('connected').style.display, 'none');

  el('token').value = 'bad';
  await el('connect').onclick();
  assert.match(el('status').textContent, /does not look like/);
  assert.equal(el('connect').disabled, false);

  el('token').value = GOOD_TOKEN;
  await el('connect').onclick();
  assert.match(el('status').textContent, /^Connected\. 3 EPUBs in your Reader library\./);
  assert.equal(el('token').value, '', 'token field cleared');
  assert.equal(el('signin').style.display, 'none');
  assert.equal(el('connected').style.display, '');
  assert.deepEqual(JSON.parse(api.files[DIR + '/config.json']), { token: GOOD_TOKEN });

  await el('disconnect').onclick();
  assert.match(el('status').textContent, /^Disconnected/);
  assert.equal(el('signin').style.display, '');
  assert.deepEqual(JSON.parse(api.files[DIR + '/config.json']), {});
});

test('settings card starts connected when config.json holds a token', async () => {
  const p = await loadPlugin();
  const api = fakeApi({
    responses: { [COUNT]: { status: 200, body: '{"count": 12}' } },
    files: { [DIR + '/config.json']: JSON.stringify({ token: GOOD_TOKEN }) },
  });
  const c = fakeContainer();
  await p.render(c, api, fakeFetch(api));
  assert.match(c.elements['rwr-status'].textContent, /^Connected\. 12 EPUBs/);
  assert.equal(c.elements['rwr-signin'].style.display, 'none');
});
