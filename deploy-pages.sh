#!/usr/bin/env bash
# Publishes this folder to GitHub and turns on GitHub Pages.
# Run from a terminal:  bash deploy-pages.sh
# Needs git and the GitHub CLI (gh). It makes a PUBLIC repo named tap-sprint under your GitHub account.
set -euo pipefail
cd "$(dirname "$0")"
REPO="${1:-tap-sprint}"

command -v git >/dev/null || { echo "git is not installed."; exit 1; }
command -v gh >/dev/null || { echo "Install the GitHub CLI first: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login

OWNER="$(gh api user -q .login)"
ID="$(gh api user -q .id)"

[ -d .git ] || git init -b main
git config user.name >/dev/null 2>&1 || git config user.name "$OWNER"
git config user.email >/dev/null 2>&1 || git config user.email "${ID}+${OWNER}@users.noreply.github.com"

git add .
git diff --cached --quiet || git commit -m "Tap Sprint: tap speed game with input-method leaderboards"

if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  if ! git remote get-url origin >/dev/null 2>&1; then
    if [ "$(gh config get git_protocol 2>/dev/null)" = "ssh" ]; then
      git remote add origin "git@github.com:$OWNER/$REPO.git"
    else
      git remote add origin "https://github.com/$OWNER/$REPO.git"
    fi
  fi
  git push -u origin HEAD:main
else
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi

gh api -X POST "repos/$OWNER/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  || echo "(GitHub Pages was probably already on; if the site does not appear, enable it in the repo's Settings > Pages: branch main, folder /)"

echo
echo "Done. Your game will be at: https://$OWNER.github.io/$REPO/"
echo "The first publish can take a minute or two."
