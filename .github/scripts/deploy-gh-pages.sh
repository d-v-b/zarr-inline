#!/usr/bin/env bash
# Publish (or remove) content on the gh-pages branch.
#
#   deploy-gh-pages.sh <site-dir> ""                <msg>   publish to the root,
#                                                           preserving previews/
#   deploy-gh-pages.sh <site-dir> previews/pr-7     <msg>   replace that subdir
#   deploy-gh-pages.sh -          previews/pr-7     <msg>   delete that subdir
#
# Needs GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.
set -euo pipefail

SITE_DIR=$1
DEST=${2:-}
MESSAGE=$3
REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
WORK=$(mktemp -d)

if git ls-remote --exit-code "$REMOTE" gh-pages >/dev/null 2>&1; then
	git clone --depth 1 --branch gh-pages "$REMOTE" "$WORK"
else
	git init -b gh-pages "$WORK"
	git -C "$WORK" remote add origin "$REMOTE"
fi
cd "$WORK"

if [ "$SITE_DIR" = "-" ]; then
	rm -rf "${DEST:?refusing to delete the root}"
elif [ -z "$DEST" ]; then
	# Root deploy: replace everything except the PR previews.
	find . -mindepth 1 -maxdepth 1 ! -name .git ! -name previews -exec rm -rf {} +
	cp -R "$SITE_DIR"/. .
else
	rm -rf "$DEST"
	mkdir -p "$DEST"
	cp -R "$SITE_DIR"/. "$DEST"/
fi
touch .nojekyll

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if ! git commit -m "$MESSAGE"; then
	echo "nothing to deploy"
	exit 0
fi
for attempt in 1 2 3; do
	if git push origin gh-pages; then
		exit 0
	fi
	git pull --rebase origin gh-pages
done
echo "push failed after 3 attempts" >&2
exit 1
