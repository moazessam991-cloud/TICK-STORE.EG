#!/usr/bin/env bash
# Run this on YOUR machine (Terminal.app / iTerm), not inside a restricted sandbox.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f public/index.html ]]; then
  echo "Missing public/index.html — copy your storefront HTML there first."
  exit 1
fi

if [[ ! -d .git ]]; then
  git init
  git branch -M main
fi

git add -A
git status

if ! git diff --cached --quiet || ! git diff --quiet 2>/dev/null; then
  git commit -m "TICK store: API, SQLite, bundled site, Twilio hooks"
else
  echo "Nothing to commit."
fi

echo ""
echo "Create the repo on GitHub, then run ONE of:"
echo "  1) gh repo create YOUR-REPO-NAME --public --source=. --remote=origin --push"
echo "  2) git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git"
echo "     git push -u origin main"
echo ""
