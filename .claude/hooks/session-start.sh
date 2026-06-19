#!/bin/bash
# SessionStart hook — ensure JS dev-deps (jsdom, @roamhq/wrtc, puppeteer) are installed
# so `node --test` and the puppeteer file:// smoke scripts work in a fresh
# Claude-Code-on-the-web container. Idempotent; safe to re-run.
set -euo pipefail

# Only needed in the remote (web) container; local machines manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"
# `install` (not `ci`) so the cached container layer is reused across sessions.
npm install --no-audit --no-fund
