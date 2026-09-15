#!/usr/bin/env bash
set -Eeuo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./scripts/restore.sh <path-to-backup.tar.gz>"
  exit 1
fi

ARCHIVE_PATH="$1"
if [ ! -f "${ARCHIVE_PATH}" ]; then
  echo "Error: Backup archive file '${ARCHIVE_PATH}' not found."
  exit 1
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo "=================================================="
echo "📦 Customer 360 Enterprise Restore System"
echo "Archive: ${ARCHIVE_PATH}"
echo "=================================================="

# Extract backup bundle
tar -xzf "${ARCHIVE_PATH}" -C "${TEMP_DIR}"
BUNDLE_DIR=$(find "${TEMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)

# 1. Restore Database
if [ -f "${BUNDLE_DIR}/database.sql.gz" ]; then
  echo "--> [1/3] Restoring PostgreSQL database..."
  if command -v docker &>/dev/null && docker compose ps --services 2>/dev/null | grep -q db; then
    gunzip -c "${BUNDLE_DIR}/database.sql.gz" | docker compose exec -T db psql -U "${POSTGRES_USER:-customer360}" -d "${POSTGRES_DB:-customer360}"
  else
    gunzip -c "${BUNDLE_DIR}/database.sql.gz" | PGPASSWORD="${POSTGRES_PASSWORD:-customer360_dev_password}" psql -h "${POSTGRES_HOST:-db}" -U "${POSTGRES_USER:-customer360}" -d "${POSTGRES_DB:-customer360}"
  fi
fi

# 2. Restore Documents
if [ -f "${BUNDLE_DIR}/company_documents.tar.gz" ]; then
  echo "--> [2/3] Restoring company documents..."
  mkdir -p /data/company-documents
  if [ -d "/data/company-documents" ]; then
    tar -xzf "${BUNDLE_DIR}/company_documents.tar.gz" -C /data/company-documents
  fi
fi

# 3. Restore CRM Session
if [ -f "${BUNDLE_DIR}/crm_session.tar.gz" ]; then
  echo "--> [3/3] Restoring CRM session..."
  mkdir -p /data/crm-session
  if [ -d "/data/crm-session" ]; then
    tar -xzf "${BUNDLE_DIR}/crm_session.tar.gz" -C /data/crm-session
  fi
fi

echo "=================================================="
echo "✅ System restored successfully!"
echo "=================================================="
