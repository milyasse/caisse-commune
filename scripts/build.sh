#!/bin/sh
# Construit la PWA dans dist/ (bundle unique app.js + fichiers statiques).
# Avec npm : npm run build (esbuild). Ici : bun build, équivalent.
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
if command -v bun >/dev/null 2>&1; then
  bun build src/main.tsx --outfile dist/app.js --minify --target browser --define process.env.NODE_ENV='"production"'
else
  npx esbuild src/main.tsx --bundle --minify --format=esm --outfile=dist/app.js --define:process.env.NODE_ENV='"production"'
fi
cp web/* dist/
echo "dist/ prêt"
