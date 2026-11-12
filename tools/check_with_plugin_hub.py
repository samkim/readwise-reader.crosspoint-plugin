"""Runs this repository through Plugin Hub's own catalog code.

Uses build_entry() (automatic discovery), markdown_details_to_html()
(DETAILS.md rendering) and inspect_release_asset() (ZIP checks) from a local
checkout of crosspoint-reader/crosspoint-plugin-hub, with a fake GitHub client
that serves files from this working tree instead of a published Release.

Usage: python3 tools/check_with_plugin_hub.py <plugin-hub-checkout> [repo-root]
Run `node tools/pack.mjs` first so dist/ holds the ZIP.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    hub = Path(sys.argv[1]).resolve()
    repo_root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(hub / "tools"))
    import build_catalog as bc  # noqa: E402  (Plugin Hub production code)

    payloads = [p for p in repo_root.iterdir() if p.is_dir() and p.name.endswith(bc.PLUGIN_DIRECTORY_SUFFIX)]
    manifest = json.loads((payloads[0] / "manifest.json").read_text(encoding="utf-8")) if payloads else {}
    version = manifest.get("version", "")
    tag = f"v{version}"
    full_name = f"example-owner/{repo_root.name}"

    class LocalClient:
        def _listing(self, directory: Path) -> list[dict]:
            return [
                {"name": p.name, "type": "dir" if p.is_dir() else "file"}
                for p in sorted(directory.iterdir())
                if not p.name.startswith(".")
            ]

        def root_contents(self, repo: str, ref: str) -> list[dict]:
            return self._listing(repo_root)

        def directory_contents(self, repo: str, ref: str, path: str) -> list[dict]:
            return self._listing(repo_root / path)

        def json_file(self, repo: str, ref: str, path: str):
            return json.loads((repo_root / path).read_text(encoding="utf-8"))

        def text_file(self, repo: str, ref: str, path: str) -> str:
            return (repo_root / path).read_text(encoding="utf-8")

    repo = {"full_name": full_name, "name": repo_root.name, "owner": {"login": "example-owner"}}
    release = {"tag_name": tag, "html_url": "", "published_at": ""}
    entry = bc.build_entry(LocalClient(), repo, release)
    if entry is None:
        print("FAIL: Plugin Hub build_entry() skipped the repository (reason printed above)", file=sys.stderr)
        return 1

    details = entry.pop("_details_markdown", None)
    if details is not None:
        html = bc.markdown_details_to_html(details)
        print(f"ok: DETAILS.md renders to {len(html.encode('utf-8'))} bytes of HTML")
    print("ok: catalog entry")
    print(json.dumps(entry, indent=1))

    zip_path = repo_root / "dist" / f"{entry['name']}-{version}.crosspoint-plugin.zip"
    if not zip_path.exists():
        print(f"FAIL: {zip_path} not found; run node tools/pack.mjs first", file=sys.stderr)
        return 1
    zip_manifest, files, payload = bc.inspect_release_asset(zip_path.read_bytes(), full_name, zip_path.name)
    if zip_manifest.get("version") != version or zip_manifest.get("name") != entry["name"]:
        print("FAIL: ZIP manifest does not match the payload manifest", file=sys.stderr)
        return 1
    if sorted(files) != sorted(entry["files"]):
        print("FAIL: ZIP files differ from the catalog entry files", file=sys.stderr)
        return 1
    for name, data in payload.items():
        if data != (payloads[0] / name).read_bytes():
            print(f"FAIL: ZIP member {name} differs from the payload", file=sys.stderr)
            return 1
    print(f"ok: {zip_path.name} passes inspect_release_asset ({len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
