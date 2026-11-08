#!/usr/bin/env bash
# Publishes main plus generated files to the `deploy` branch.
# Inputs (env): GITHUB_SHA = the main commit being deployed.
# Run from the repo root of a full-history checkout with `origin` set.
# deploy is append-only: every commit has the previous deploy tip and the main
# commit as parents, and the push is never forced, so a rejected push fails loudly.
set -euo pipefail

: "${GITHUB_SHA:?GITHUB_SHA must be set}"
readonly SHA="$GITHUB_SHA"
readonly SHORT="${SHA:0:7}"

# A newer push to main has its own run; deploying this older sha would be stale.
remote_main=$(git ls-remote origin refs/heads/main | cut -f1)
if [ -z "$remote_main" ]; then
  echo "::error::origin has no refs/heads/main" >&2
  exit 1
fi
if [ "$remote_main" != "$SHA" ]; then
  echo "main moved to $remote_main; $SHA is stale, a newer run will deploy."
  exit 0
fi

# Placeholder build step. The bundle step later adds `npm run build` here and the
# generated www/pulse-card.js; until then the tree is main as is.

# Force-add generated files that .gitignore hides (none yet).
git add -A
tree=$(git write-tree)

parents=()
if [ -n "$(git ls-remote origin refs/heads/deploy)" ]; then
  git fetch --no-tags origin refs/heads/deploy:refs/remotes/origin/deploy
  deploy_tip=$(git rev-parse refs/remotes/origin/deploy)
  if [ "$(git rev-parse "$deploy_tip^{tree}")" = "$tree" ]; then
    echo "deploy $deploy_tip already has this tree; nothing to publish."
    exit 0
  fi
  parents+=(-p "$deploy_tip")
fi
parents+=(-p "$SHA")

subject=$(git log -1 --format=%s "$SHA")
export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
commit=$(git commit-tree "$tree" "${parents[@]}" -m "Deploy $SHORT: $subject")

tag="deploy/$(date -u +%Y-%m-%d)-$SHORT"
echo "Publishing $commit to deploy, tagged $tag"
# No --force: only a fast-forward is accepted.
git push origin "$commit:refs/heads/deploy"
git tag "$tag" "$commit"
git push origin "refs/tags/$tag"
