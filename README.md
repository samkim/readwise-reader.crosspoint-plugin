# Readwise Reader for CrossPoint

A [CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader) plugin that lets you browse the EPUBs in your [Readwise Reader](https://readwise.io/read) library on the reader and download them to the SD card. Not affiliated with Readwise.

## What it does

- **On the reader** (`device.json`): Home → Plugins → Readwise Reader lists your EPUBs by location (Inbox, Later, Shortlist, Archive, All EPUBs). Picking one downloads the original file to `/Readwise/<title>.epub`.
- **In the reader's web page** (`plugin.js`): a settings card where you paste your Readwise access token and tap **Connect**, or **Disconnect** to remove it.

CrossPoint has no on-device text entry for plugins, and Readwise offers no device-code sign-in, so the token is entered from a phone or computer.

## Setup

1. Install from Plugin Hub on the reader, or copy `readwise-reader.crosspoint-plugin/` to `/.crosspoint/plugins/readwise-reader/` on the SD card.
2. Get a token at <https://readwise.io/access_token>.
3. Turn on File Transfer, open the reader's address in a browser, go to **Settings**, paste the token on the **Readwise Reader** card and tap **Connect**. The card checks the token against Readwise first.
4. On the reader, open Home → Plugins → Readwise Reader.

Fallback without the web card: create `config.json` containing `{"token":"YOUR_TOKEN"}` in the plugin folder.

## How it works

| Step | Request |
| --- | --- |
| List | `GET https://readwise.io/api/v3/list/?category=epub&location=<loc>&limit=100` with `Authorization: Token {token}` |
| Resolve file | `GET https://readwise.io/api/v3/list/?id={id}&withRawSourceUrl=true`, reading `results.0.raw_source_url` (a presigned S3 link valid for one hour) |
| Download | `GET <raw_source_url>` with **no** Authorization header. The firmware drops download headers when `url_path` returns a full URL. |
| Token check (web card) | `GET https://readwise.io/api/v2/auth/` → `204` |

## Firmware support

| Firmware | Status |
| --- | --- |
| Stock CrossPoint 2.0.0 and later | Supported: plugin system enabled (Settings → Connectivity → Plugins), plugin API 1, `url_path` download resolution without forwarding headers to presigned URLs. |
| Other CrossPoint-family firmware | Should work if it advertises `firmware_family=crosspoint` and `plugin_api>=1` and implements the same `device.json` catalog. Not tested. |

The manifest declares only `firmware_family: crosspoint` and `plugin_api_min: 1`. It requires no optional capabilities.

## Limits

- **EPUBs only.** Readwise has no EPUB export for articles, and the firmware cannot convert HTML, so articles, PDFs, emails and RSS items are not listed.
- **Up to 100 per list.** Readwise pages with a `pageCursor`; the firmware catalog only supports `{page}`/`{offset}` paging, so each list is one request with Readwise's maximum `limit=100`.
- **Non-distributable documents** (e.g. Wisereads previews) have an empty `raw_source_url`, so their download fails.
- **Rate limit:** the list endpoint allows 20 requests per minute per token. Each download uses one.
- **Token storage:** the token is stored unencrypted in `config.json` in the plugin folder. **Disconnect** writes an empty config. You can also revoke the token on readwise.io.

## Development

Requires Node.js 22.2+ (no npm dependencies) and, for the Plugin Hub check, Python 3.10+.

```sh
npm test                                   # plugin.js behaviour + payload/ZIP checks
node tools/validate.mjs                    # Plugin Hub contract checks on the payload
node tools/pack.mjs                        # dist/readwise-reader-<version>.crosspoint-plugin.zip
git clone --depth 1 https://github.com/crosspoint-reader/crosspoint-plugin-hub .plugin-hub
python3 tools/check_with_plugin_hub.py .plugin-hub   # Plugin Hub's own build_entry / ZIP inspection
```

Only the files listed in `readwise-reader.crosspoint-plugin/manifest.json` → `files` are installed. Everything else in this repository is development-only.

## Publishing to Plugin Hub

1. Make the repository public and add the GitHub topic `crosspoint-plugin`.
2. Bump the version in `manifest.json` and `package.json`, and add a `CHANGELOG.md` section.
3. Push a tag `v<version>`. The Release workflow runs the checks and publishes a stable Release with the ZIP attached.
4. Plugin Hub's catalog refresh (every three hours) picks it up. No Plugin Hub PR is needed.

Never move or reuse a release tag. Every change for installed users needs a new version.
