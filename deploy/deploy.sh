#!/usr/bin/env bash
# Deploys the commit checked out in this repository. CI publishes the api and
# web images for every commit on main that passes its checks; this pulls the
# pair for HEAD, backs up the database, and restarts what changed. The server
# never builds.
#
#   git pull                     # deploys, through the post-merge hook below
#   ./deploy.sh                  # deploys HEAD again, e.g. after CI finishes
#   git checkout <commit> && ./deploy.sh    # rolls back (git checkout main to return)
#
# The hook, installed once on the server from the repository root:
#
#   printf '#!/bin/sh\nexec deploy/deploy.sh\n' > .git/hooks/post-merge
#   chmod +x .git/hooks/post-merge
#
# Migrations run when the new api container starts and are forward-only, so a
# rollback across a migration also needs the database restored from the backup
# this script writes before every new release.
set -euo pipefail

# Git exports these to hooks, relative to the repository root.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
cd "$(dirname "$0")"

REGISTRY=ghcr.io/mhdajfer
BACKUP_DIR="${SHELF_BACKUP_DIR:-$HOME/shelf-backups}"
KEEP_BACKUPS=10
# Images kept per app: the one running and the one before it, for a rollback.
KEEP_RELEASES=2

log() { printf '\n==> %s\n' "$*"; }
die() {
  printf '\ndeploy: %s\n' "$*" >&2
  exit 1
}

exec 9> /tmp/shelf-deploy.lock
flock -n 9 || die "another deploy is running"

[ -f .env ] || die "deploy/.env is missing: copy .env.example to .env and fill it in"

# The server runs what is in the repository and nothing else.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  die "tracked files are modified on the server. Make the change in the repository instead, and discard it here with: git checkout -- <file>"
fi

env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
tag="$(git rev-parse HEAD)"
previous="$(env_value SHELF_TAG)"
site_host="$(env_value SITE_HOST)"
release="$(git log -1 --format='%h %s')"

log "pulling the images for $release"
for app in api web; do
  if ! docker pull --quiet "$REGISTRY/shelf-$app:$tag" > /dev/null; then
    die "could not pull the $app image for ${tag:0:7}. CI publishes one only after every check on that commit passes (https://github.com/mhdajfer/Shelf/actions), and the package must be public. The running site was not touched; run ./deploy.sh again once the images exist."
  fi
done

built_for="$(docker image inspect --format '{{ index .Config.Labels "in.mhdajfer.shelf.site-host" }}' "$REGISTRY/shelf-web:$tag")"
if [ "$built_for" != "$site_host" ]; then
  die "the web image was built for '$built_for', but SITE_HOST in .env is '$site_host'. Change SITE_HOST in .github/workflows/ci.yml and let CI build again."
fi

# Compose reads SHELF_TAG from here before .env, which is not updated until the
# backup is safely written.
export SHELF_TAG="$tag"

if [ "$tag" = "$previous" ]; then
  log "${tag:0:7} is already the deployed release; making sure it is running"
elif [ -n "$(docker compose ps --status running --quiet postgres)" ]; then
  log "backing up the database"
  (
    umask 077
    mkdir -p "$BACKUP_DIR"
    file="$BACKUP_DIR/shelf-$(date -u +%Y%m%dT%H%M%SZ)-${previous:0:7}.dump"
    docker compose exec -T postgres pg_dump -U shelf -d shelf -Fc > "$file.partial"
    mv "$file.partial" "$file"
    echo "$file ($(du -h "$file" | cut -f1))"
  )
  ls -1t "$BACKUP_DIR"/shelf-*.dump | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm --
else
  log "Postgres is not running, so there is nothing to back up"
fi

(
  umask 077
  {
    grep -v '^SHELF_TAG=' .env || true
    echo "SHELF_TAG=$tag"
  } > .env.next
  mv .env.next .env
)

log "starting ${tag:0:7}"
if ! docker compose up -d --wait --wait-timeout 300 --remove-orphans; then
  docker compose ps >&2
  die "a service did not become healthy. Read its log with: docker compose logs --since 10m api (or web). To go back: git checkout ${previous:0:7} && ./deploy.sh, and restore the latest dump in $BACKUP_DIR if a migration ran."
fi

# The Caddyfile is mounted as a single file, and git replaces the file rather
# than writing into it, so the running Caddy keeps the old copy until it is
# recreated. The certificate lives in a volume and is kept.
if ! docker compose exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - Caddyfile; then
  log "the Caddyfile changed; recreating caddy"
  docker compose up -d --wait --force-recreate --no-deps caddy
fi

log "removing old images"
for app in api web; do
  docker image ls "$REGISTRY/shelf-$app" --format '{{.Tag}}' |
    tail -n +$((KEEP_RELEASES + 1)) |
    while read -r old; do
      # A tag still used by a container is refused, and kept.
      docker image rm "$REGISTRY/shelf-$app:$old" > /dev/null 2>&1 || true
    done
done
docker image prune -f > /dev/null

docker compose ps
log "deployed $release${previous:+ (was ${previous:0:7})}"
