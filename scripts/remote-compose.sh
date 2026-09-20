#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_HOST="${CUSTOMER360_REMOTE_HOST:-shangrila002@100.94.204.57}"
REMOTE_DIR="${CUSTOMER360_REMOTE_DIR:-customer360-dev}"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.remote.yml)

usage() {
  cat <<'EOF'
Usage: scripts/remote-compose.sh COMMAND [ARGS...]

Commands:
  init              Create the remote directory and a server-only .env
  deploy            Git-pull deploy: fetch, fast-forward, rebuild, migrate
  sync              Synchronize source files to the server (rsync, legacy)
  dev               Start the stack, then continuously synchronize changes
  up [ARGS...]      Synchronize and run `docker compose up -d --build`
  down [ARGS...]    Stop the remote stack (volumes are preserved)
  logs [ARGS...]    Follow remote Compose logs
  ps                Show remote service status
  exec SERVICE ...  Run a command in a remote service
  compose ...       Run any Docker Compose subcommand on the server
  tunnel            Forward the application ports to this laptop

Configuration:
  CUSTOMER360_REMOTE_HOST  SSH destination (default: shangrila002@100.94.204.57)
  CUSTOMER360_REMOTE_DIR   Directory below the remote home (default: customer360-dev)
EOF
}

die() {
  printf 'remote-compose: %s\n' "$*" >&2
  exit 1
}

case "$REMOTE_DIR" in
  ""|/|.|..|~) die "CUSTOMER360_REMOTE_DIR must be a dedicated project directory" ;;
esac

remote() {
  local command quoted arg
  command="cd -- $(printf '%q' "$REMOTE_DIR") &&"
  for arg in "$@"; do
    printf -v quoted '%q' "$arg"
    command+=" $quoted"
  done
  ssh "$REMOTE_HOST" "$command"
}

ensure_remote_dir() {
  local quoted
  printf -v quoted '%q' "$REMOTE_DIR"
  ssh "$REMOTE_HOST" "mkdir -p -- $quoted"
}

sync_project() {
  command -v rsync >/dev/null || die "rsync is required on the laptop"
  ensure_remote_dir
  rsync -az --delete \
    --exclude='.git/' \
    --exclude='.env' \
    --exclude='.venv/' \
    --exclude='venv/' \
    --exclude='node_modules/' \
    --exclude='dist/' \
    --exclude='__pycache__/' \
    --exclude='.pytest_cache/' \
    --exclude='crm-session/' \
    --exclude='crm-snapshots/' \
    --exclude='storage-state.json' \
    ./ "$REMOTE_HOST:$REMOTE_DIR/"
}

init_remote() {
  sync_project
  remote sh -c 'if [ ! -f .env ]; then cp .env.example .env && chmod 600 .env; fi'
  printf 'Initialized %s:%s\nEdit the server-only environment with:\n  ssh %q "cd %q && nano .env"\n' \
    "$REMOTE_HOST" "$REMOTE_DIR" "$REMOTE_HOST" "$REMOTE_DIR"
}

compose() {
  remote docker compose "${COMPOSE_FILES[@]}" "$@"
}

command="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
  init) init_remote ;;
  deploy)
    printf '==> Deploying to %s:%s\n' "$REMOTE_HOST" "$REMOTE_DIR"
    remote git fetch origin
    remote git reset --hard origin/main
    ssh "$REMOTE_HOST" "cd $REMOTE_DIR && docker run --rm -v \"\$(pwd)/frontend/dist:/target\" alpine sh -c 'rm -rf /target/*'"
    remote sh -c "cd frontend && npm ci --prefer-offline && npm run build"
    compose up -d --build
    compose exec -T backend alembic upgrade head
    printf '==> Deployed %s\n' "$(remote git rev-parse --short HEAD)"
    ;;
  sync) sync_project ;;
  up)
    sync_project
    compose up -d --build "$@"
    ;;
  dev)
    sync_project
    compose up -d --build "$@"
    printf 'Remote stack is running. Synchronizing changes; press Ctrl-C to stop syncing.\n'
    while :; do
      sync_project
      sleep 1
    done
    ;;
  down) compose down "$@" ;;
  logs) compose logs -f "$@" ;;
  ps) compose ps "$@" ;;
  exec)
    [ "$#" -gt 0 ] || die "exec requires a service name"
    compose exec "$@"
    ;;
  compose) compose "$@" ;;
  tunnel)
    printf 'Forwarding frontend, API, pgAdmin, and PostgreSQL. Press Ctrl-C to close.\n'
    ssh -N \
      -L 5173:127.0.0.1:5173 \
      -L 8000:127.0.0.1:8000 \
      -L 5050:127.0.0.1:5051 \
      -L 5432:127.0.0.1:5432 \
      "$REMOTE_HOST"
    ;;
  -h|--help|help|"") usage ;;
  *) die "unknown command: $command (run with --help)" ;;
esac
