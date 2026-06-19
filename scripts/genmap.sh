#!/bin/bash
# Generate docs/MAP.md — a per-file table of contents (section banners + top-level
# functions) for the feature scripts, so navigation doesn't require reading whole files.
# Run after structural changes:  bash scripts/genmap.sh
set -euo pipefail
cd "$(dirname "$0")/.."
out=docs/MAP.md
{
  echo "# Repo map (auto-generated — \`bash scripts/genmap.sh\`; do not hand-edit)"
  echo
  echo "Per-file index of section banners (\`// ===== / // -----\`) and top-level \`function\`s,"
  echo "with line numbers. Grep/jump here instead of reading whole files. See CLAUDE.md for architecture."
  echo
  for f in $(find features -name '*.js' | sort); do
    echo "## \`$f\`"
    echo '```'
    grep -nE '^  //\s*[=-]{3,}|^  // =+ |^  function [A-Za-z0-9_]+' "$f" \
      | sed -E 's/^([0-9]+):  \/\/ ?/\1  § /; s/^([0-9]+):  function ([A-Za-z0-9_]+).*/\1    fn \2()/' \
      || echo "  (no banners/functions)"
    echo '```'
    echo
  done
} > "$out"
echo "wrote $out ($(wc -l < "$out") lines)"
