#!/bin/sh
# Builds the GitHub Pages site into OUT (default .scratch/site): the landing
# page from docs/site/ at the root, the captures under media/, the manual
# (mdBook) under manual/, and the app under app/ when dist/ has been built
# (npm run build). The same script runs locally and in
# .github/workflows/pages.yml.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/../.scratch/site}
case $out in /*) ;; *) out=$PWD/$out ;; esac
rm -rf "$out"
mkdir -p "$out/media"
cp -R "$here/site/." "$out/"
cp "$here/media/"*.webp "$out/media/"
mdbook build "$here/manual" -d "$out/manual"
if [ -d "$here/../dist" ]; then
  mkdir -p "$out/app" && cp -R "$here/../dist/." "$out/app/"
fi
echo "site built in $out"
