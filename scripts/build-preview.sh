#!/bin/sh
# Construit un aperçu autonome en un seul fichier HTML (publié comme artifact claude.ai).
set -e
cd "$(dirname "$0")/.."
OUT=${1:-preview}
mkdir -p "$OUT"
bun build src/main.tsx --outfile "$OUT/app.js" --minify --target browser --define process.env.NODE_ENV='"production"' --define __PREVIEW__=true >/dev/null
node -e '
const fs = require("fs");
const out = process.argv[1];
const js = fs.readFileSync(out + "/app.js", "utf8").replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync("web/styles.css", "utf8");
fs.writeFileSync(out + "/caisse-commune.html",
`<title>Caisse commune</title>
<meta name="theme-color" content="#17633d">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`);' "$OUT"
rm "$OUT/app.js"
echo "$OUT/caisse-commune.html"
