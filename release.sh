#!/usr/bin/env bash
# Cut a release: build the .xpi, regenerate update.json from manifest.json,
# commit, push, and publish a GitHub release with the .xpi attached.
# Bump "version" in manifest.json first, then run ./release.sh
set -euo pipefail
cd "$(dirname "$0")"

REPO="ievlevpn/zotero-sentence-focus"
XPI="sentence-focus.xpi"
VER=$(node -p "require('./manifest.json').version")

node test.js
rm -f "$XPI"
zip -q -r "$XPI" manifest.json bootstrap.js icon.svg prefs.xhtml prefs.js prefs.css

# Regenerate update.json so update_link always points at this version's asset.
REPO="$REPO" node -e '
const fs = require("fs");
const m = require("./manifest.json");
const z = m.applications.zotero;
const repo = process.env.REPO;
const out = { addons: { [z.id]: { updates: [{
  version: m.version,
  update_link: `https://github.com/${repo}/releases/download/v${m.version}/sentence-focus.xpi`,
  applications: { zotero: {
    strict_min_version: z.strict_min_version,
    ...(z.strict_max_version ? { strict_max_version: z.strict_max_version } : {}),
  } },
}] } } };
fs.writeFileSync("update.json", JSON.stringify(out, null, 2) + "\n");
'

git add -A
git commit -m "Release v$VER" || echo "(nothing to commit)"
git push

# Changelog = commits since the previous tag (drop the "Release vX" commits).
# Fetch tags first: gh creates tags remotely, so local tags go stale and
# git describe would pick an old one, repeating already-shipped changes.
git fetch --tags -q || true
PREV=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
RANGE=${PREV:+$PREV..HEAD}
CHANGES=$(git log --no-merges --pretty='- %s' $RANGE | grep -v '^- Release v' || true)
[ -z "$CHANGES" ] && CHANGES="- Initial release"

NOTES="## What's changed
$CHANGES

---
Install: download \`sentence-focus.xpi\` below → Zotero → Tools → Plugins → ⚙ → Install Plugin From File…
Existing installs update automatically."

gh release create "v$VER" "$XPI" -t "v$VER" -n "$NOTES"

echo "released v$VER"
