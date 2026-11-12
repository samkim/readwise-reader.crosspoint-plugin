import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pack } from '../tools/pack.mjs';
import { validateRepo } from '../tools/validate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = path.join(REPO, 'readwise-reader.crosspoint-plugin');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function copyRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rwr-'));
  await cp(PAYLOAD, path.join(dir, 'readwise-reader.crosspoint-plugin'), { recursive: true });
  return dir;
}

test('payload passes the Plugin Hub contract validator', async () => {
  const { errors } = await validateRepo(REPO);
  assert.deepEqual(errors, []);
});

test('versions agree: manifest, package.json and CHANGELOG', async () => {
  const manifest = await readJson(path.join(PAYLOAD, 'manifest.json'));
  const pkg = await readJson(path.join(REPO, 'package.json'));
  assert.equal(pkg.version, manifest.version);
  const changelog = await readFile(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}\\b`, 'm'));
});

test('device.json reads the token plugin.js writes, and resolves the presigned EPUB URL', async () => {
  const device = await readJson(path.join(PAYLOAD, 'device.json'));
  assert.equal(device.token.file, 'config.json');
  assert.equal(device.token.path, 'token');
  assert.equal(device.browse.headers.Authorization, 'Token {token}');
  assert.equal(device.browse.items, 'results');
  for (const list of device.browse.lists) {
    const url = new URL(list.url);
    assert.equal(url.origin + url.pathname, 'https://readwise.io/api/v3/list/');
    assert.equal(url.searchParams.get('category'), 'epub', `${list.title} lists only EPUBs`);
    assert.equal(url.searchParams.get('limit'), '100', 'Readwise maximum page; firmware has no cursor paging');
    for (const forbidden of ['{page}', '{offset}', 'withHtmlContent']) assert.ok(!list.url.includes(forbidden));
  }
  assert.equal(device.download.url_path, 'results.0.raw_source_url');
  assert.match(device.download.url, /[?&]id=\{id\}/);
  assert.match(device.download.url, /[?&]withRawSourceUrl=true/);
  assert.match(device.download.filename, /\.epub$/);
});

test('validator rejects contract violations', async () => {
  const cases = [
    ['name mismatch', async (d) => {
      const m = await readJson(path.join(d, 'readwise-reader.crosspoint-plugin/manifest.json'));
      m.name = 'other';
      await writeFile(path.join(d, 'readwise-reader.crosspoint-plugin/manifest.json'), JSON.stringify(m));
    }, /must equal directory stem/],
    ['two-part version', async (d) => {
      const m = await readJson(path.join(d, 'readwise-reader.crosspoint-plugin/manifest.json'));
      m.version = '1.0';
      await writeFile(path.join(d, 'readwise-reader.crosspoint-plugin/manifest.json'), JSON.stringify(m));
    }, /MAJOR\.MINOR\.PATCH/],
    ['traversal in files', async (d) => {
      const m = await readJson(path.join(d, 'readwise-reader.crosspoint-plugin/manifest.json'));
      m.files.push('../secret');
      await writeFile(path.join(d, 'readwise-reader.crosspoint-plugin/manifest.json'), JSON.stringify(m));
    }, /unsafe files entry/],
    ['undeclared payload file', async (d) => {
      await writeFile(path.join(d, 'readwise-reader.crosspoint-plugin/config.json'), '{"token":"x"}');
    }, /undeclared file: config\.json/],
    ['non-ASCII device README', async (d) => {
      await writeFile(path.join(d, 'readwise-reader.crosspoint-plugin/README.md'), 'Readwise — Reader\n');
    }, /printable ASCII/],
  ];
  for (const [label, mutate, expected] of cases) {
    const dir = await copyRepo();
    try {
      await mutate(dir);
      const { errors } = await validateRepo(dir);
      assert.ok(errors.some((e) => expected.test(e)), `${label}: got ${JSON.stringify(errors)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('pack builds a deterministic ZIP with exactly the declared files under one root', async () => {
  const dir = await copyRepo();
  try {
    const out = await pack(dir);
    const first = await readFile(out);
    assert.deepEqual(await readFile(await pack(dir)), first, 'same bytes on rebuild');
    const manifest = await readJson(path.join(PAYLOAD, 'manifest.json'));
    assert.equal(path.basename(out), `readwise-reader-${manifest.version}.crosspoint-plugin.zip`);

    const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listing, manifest.files.map((f) => 'readwise-reader.crosspoint-plugin/' + f).sort());
    execFileSync('unzip', ['-tq', out]); // CRCs and structure
    const zippedManifest = JSON.parse(execFileSync('unzip', ['-p', out, 'readwise-reader.crosspoint-plugin/manifest.json'], { encoding: 'utf8' }));
    assert.equal(zippedManifest.version, manifest.version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
