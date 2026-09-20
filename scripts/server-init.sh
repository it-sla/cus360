#!/usr/bin/env bash
# One-time setup: initialize the server with a git clone instead of rsync.
# Run FROM your local machine. After this, use `remote-compose.sh deploy`.
set -euo pipefail

REMOTE_HOST="${CUSTOMER360_REMOTE_HOST:-shangrila002@100.94.204.57}"
REMOTE_DIR="${CUSTOMER360_REMOTE_DIR:-customer360-dev}"
REPO_URL="https://github.com/it-sla/cus360.git"

echo "==> Cloning repo on $REMOTE_HOST:$REMOTE_DIR"
ssh "$REMOTE_HOST" "
  if [ -d '$REMOTE_DIR/.git' ]; then
    echo 'Already a git repo, skipping clone.'
  else
    # Back up existing .env if present
    [ -f '$REMOTE_DIR/.env' ] && cp '$REMOTE_DIR/.env' /tmp/customer360-env-backup

    rm -rf '$REMOTE_DIR'
    git clone '$REPO_URL' '$REMOTE_DIR'

    # Restore .env
    [ -f /tmp/customer360-env-backup ] && mv /tmp/customer360-env-backup '$REMOTE_DIR/.env'
  fi
"

echo "==> Done. Now run: ./scripts/remote-compose.sh deploy"
echo "    Edit server .env: ssh $REMOTE_HOST \"cd $REMOTE_DIR && nano .env\""
