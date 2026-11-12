// Checks the installable payload against the Plugin Hub plugin contract
// (PLUGIN_HUB_CONTRACT.md) and the firmware limits for device.json.
// Usage: node tools/validate.mjs [repo-root]
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SUFFIX = '.crosspoint-plugin';
const MAX_DEVICE_JSON = 8 * 1024; // firmware: device.json must be under 8 KB
const MAX_README = 2 * 1024; // device-friendly plain-text README
const MAX_DETAILS = 16 * 1024; // Plugin Hub DETAILS.md source limit
const MAX_PAGE_SIZE = 16; // firmware browse page_size bound
const KNOWN_CAPABILITIES = new Set([
  'catalog.lists', 'catalog.notices', 'catalog.bundle_install', 'catalog.version_tracking',
  'catalog.compatibility', 'catalog.item_details', 'catalog.encoded_item_fields',
  'catalog.list_index_mapping', 'catalog.list_requirements', 'catalog.server_paths',
]);

export function isSafeRelativePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 180 && !p.startsWith('/') &&
    !p.includes('\\') && !p.split('/').some((part) => part === '' || part === '.' || part === '..');
}

async function readJson(file, errors, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    errors.push(`${label} is not valid JSON: ${e.message}`);
    return null;
  }
}

export async function validateRepo(repoRoot) {
  const errors = [];
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const payloads = entries.filter((e) => e.isDirectory() && e.name.endsWith(SUFFIX)).map((e) => e.name);
  if (payloads.length !== 1) {
    errors.push(`expected exactly one direct-child *${SUFFIX} directory, found ${payloads.length}`);
    return { errors };
  }
  const payloadName = payloads[0];
  const pluginId = payloadName.slice(0, -SUFFIX.length);
  const root = path.join(repoRoot, payloadName);
  if (!PLUGIN_ID_RE.test(pluginId)) errors.push(`payload directory id "${pluginId}" is not a safe plugin id`);

  const manifest = await readJson(path.join(root, 'manifest.json'), errors, 'manifest.json');
  if (!manifest) return { errors, payloadName };
  if (manifest.name !== pluginId) errors.push(`manifest name "${manifest.name}" must equal directory stem "${pluginId}"`);
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    errors.push(`manifest version "${manifest.version}" must be MAJOR.MINOR.PATCH`);
  }
  for (const key of ['title', 'description', 'author']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) errors.push(`manifest ${key} should be a non-empty string`);
  }
  if (manifest.mount !== undefined && !['settings', 'files'].includes(manifest.mount)) {
    errors.push(`manifest mount must be "settings" or "files"`);
  }

  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > 64) {
    errors.push('manifest files must be a non-empty array of at most 64 entries');
    return { errors, payloadName, manifest };
  }
  if (new Set(files).size !== files.length) errors.push('manifest files has duplicates');
  for (const f of files) {
    if (!isSafeRelativePath(f)) { errors.push(`unsafe files entry: ${JSON.stringify(f)}`); continue; }
    if (f.startsWith(payloadName + '/')) errors.push(`files entry must not be prefixed with the payload directory: ${f}`);
    try {
      if (!(await stat(path.join(root, f))).isFile()) errors.push(`declared file is not a file: ${f}`);
    } catch {
      errors.push(`declared file is missing: ${f}`);
    }
  }
  if (!files.includes('manifest.json')) errors.push('files must include manifest.json');
  if (!files.includes('device.json') && !files.includes('plugin.js')) errors.push('files must include device.json or plugin.js');

  // Nothing undeclared in the payload: development files belong outside it.
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!files.includes(e.name)) errors.push(`payload contains an undeclared ${e.isDirectory() ? 'directory' : 'file'}: ${e.name}`);
  }

  const compat = manifest.compatibility;
  if (compat !== undefined) {
    const families = [].concat(compat.firmware_family ?? []);
    if (families.some((f) => typeof f !== 'string' || !f)) errors.push('compatibility.firmware_family must be strings');
    if (compat.plugin_api_min !== undefined && !Number.isInteger(compat.plugin_api_min)) {
      errors.push('compatibility.plugin_api_min must be an integer');
    }
    for (const cap of [].concat(compat.requires ?? [])) {
      if (!KNOWN_CAPABILITIES.has(cap)) errors.push(`compatibility.requires names an unknown capability: ${cap}`);
    }
  }

  if (files.includes('device.json')) {
    const raw = await readFile(path.join(root, 'device.json'));
    if (raw.length >= MAX_DEVICE_JSON) errors.push(`device.json is ${raw.length} bytes; firmware limit is under ${MAX_DEVICE_JSON}`);
    const device = await readJson(path.join(root, 'device.json'), errors, 'device.json');
    if (device) {
      const browse = device.browse || {};
      if (!browse.url) errors.push('device.json browse.url is required');
      if (browse.page_size !== undefined && (browse.page_size < 1 || browse.page_size > MAX_PAGE_SIZE)) {
        errors.push(`device.json browse.page_size must be 1..${MAX_PAGE_SIZE}`);
      }
      if (browse.lists && browse.lists_url) errors.push('device.json must not combine browse.lists and browse.lists_url');
      const dest = device.download && device.download.dest_dir;
      if (dest && (!dest.startsWith('/') || dest.includes('..'))) errors.push('device.json download.dest_dir must be absolute without ..');
      for (const u of [browse.url, ...(browse.lists || []).map((l) => l.url), device.download && device.download.url]) {
        if (u && !/^https:\/\//.test(u)) errors.push(`device.json URL must use https: ${u}`);
      }
    }
  }

  if (files.includes('README.md')) {
    const raw = await readFile(path.join(root, 'README.md'));
    if (raw.length > MAX_README) errors.push(`payload README.md is ${raw.length} bytes; keep it at most ${MAX_README}`);
    if (![...raw].every((b) => b === 0x0a || (b >= 0x20 && b < 0x7f))) {
      errors.push('payload README.md must be plain printable ASCII');
    }
    if (/^#/m.test(raw.toString('utf8'))) errors.push('payload README.md must not use Markdown heading markers');
  }

  if (files.includes('DETAILS.md')) {
    const raw = await readFile(path.join(root, 'DETAILS.md'));
    if (raw.length > MAX_DETAILS) errors.push(`DETAILS.md exceeds ${MAX_DETAILS} bytes`);
    try { new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { errors.push('DETAILS.md is not valid UTF-8'); }
  }

  return { errors, payloadName, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { errors, payloadName, manifest } = await validateRepo(repoRoot);
  if (errors.length) {
    for (const e of errors) console.error('error: ' + e);
    process.exit(1);
  }
  console.log(`ok: ${payloadName} ${manifest.version} (${manifest.files.length} files)`);
}
