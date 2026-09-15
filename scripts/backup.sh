#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT="${1:-./backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BUNDLE_NAME="customer360_backup_${TIMESTAMP}"
BUNDLE_DIR="${BACKUP_ROOT}/${BUNDLE_NAME}"

mkdir -p "${BUNDLE_DIR}"

echo "=================================================="
echo "📦 Customer 360 Enterprise Backup System"
echo "Timestamp: ${TIMESTAMP}"
echo "Target: ${BUNDLE_DIR}"
echo "=================================================="

# 1. Dump PostgreSQL Database (Schema + Data)
echo "--> [1/4] Dumping PostgreSQL database..."
if command -v docker &>/dev/null && docker compose ps --services 2>/dev/null | grep -q db; then
  docker compose exec -T db pg_dump -U "${POSTGRES_USER:-customer360}" "${POSTGRES_DB:-customer360}" | gzip > "${BUNDLE_DIR}/database.sql.gz"
else
  # Running from within container or fallback PGDUMP
  PGPASSWORD="${POSTGRES_PASSWORD:-customer360_dev_password}" pg_dump -h "${POSTGRES_HOST:-db}" -U "${POSTGRES_USER:-customer360}" "${POSTGRES_DB:-customer360}" | gzip > "${BUNDLE_DIR}/database.sql.gz"
fi

# 2. Archive Company Documents Volume
echo "--> [2/4] Archiving company documents..."
if [ -d "/data/company-documents" ]; then
  tar -czf "${BUNDLE_DIR}/company_documents.tar.gz" -C /data/company-documents . 2>/dev/null || true
elif command -v docker &>/dev/null; then
  docker compose exec -T backend tar -czf - -C /data/company-documents . > "${BUNDLE_DIR}/company_documents.tar.gz" 2>/dev/null || true
fi

# 3. Archive CRM Session State
echo "--> [3/4] Archiving CRM session state..."
if [ -d "/data/crm-session" ]; then
  tar -czf "${BUNDLE_DIR}/crm_session.tar.gz" -C /data/crm-session . 2>/dev/null || true
elif command -v docker &>/dev/null; then
  docker compose exec -T backend tar -czf - -C /data/crm-session . > "${BUNDLE_DIR}/crm_session.tar.gz" 2>/dev/null || true
fi

# 4. Generate Manifest JSON
echo "--> [4/4] Creating manifest metadata..."
cat <<EOF > "${BUNDLE_DIR}/manifest.json"
{
  "timestamp": "${TIMESTAMP}",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "database_dump": "database.sql.gz",
  "documents_archive": "company_documents.tar.gz",
  "crm_session_archive": "crm_session.tar.gz"
}
EOF

# Compress full backup bundle
FINAL_ARCHIVE="${BACKUP_ROOT}/${BUNDLE_NAME}.tar.gz"
tar -czf "${FINAL_ARCHIVE}" -C "${BACKUP_ROOT}" "${BUNDLE_NAME}"
rm -rf "${BUNDLE_DIR}"

echo "=================================================="
echo "✅ Backup created successfully!"
echo "File: ${FINAL_ARCHIVE}"
echo "Size: $(du -h "${FINAL_ARCHIVE}" | cut -f1)"
echo "=================================================="
