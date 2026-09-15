#!/usr/bin/env bash
set -Eeuo pipefail

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BUNDLE_NAME="courier_intelligence_full_migration_${TIMESTAMP}"
BUNDLE_FILE="${BUNDLE_NAME}.tar.gz"

echo "=================================================="
echo "📦 Courier Intelligence — Complete Migration Package Generator"
echo "Timestamp: ${TIMESTAMP}"
echo "=================================================="

STAGING_DIR="./backups/${BUNDLE_NAME}"
mkdir -p "${STAGING_DIR}"

echo "--> Step 1/3: Exporting PostgreSQL Database Dump..."
if [ -f "./scripts/remote-compose.sh" ]; then
  ./scripts/remote-compose.sh exec db pg_dump -U customer360 customer360 | gzip > "${STAGING_DIR}/database.sql.gz" || true
fi
if [ ! -s "${STAGING_DIR}/database.sql.gz" ]; then
  docker compose exec -T db pg_dump -U customer360 customer360 | gzip > "${STAGING_DIR}/database.sql.gz" 2>/dev/null || true
fi

echo "--> Step 2/3: Archiving Uploaded Documents & CRM Session..."
mkdir -p "${STAGING_DIR}/documents"
if [ -f "./scripts/remote-compose.sh" ]; then
  ./scripts/remote-compose.sh exec backend tar -czf - -C /data/company-documents . > "${STAGING_DIR}/documents/company_documents.tar.gz" 2>/dev/null || true
  ./scripts/remote-compose.sh exec backend tar -czf - -C /data/crm-session . > "${STAGING_DIR}/documents/crm_session.tar.gz" 2>/dev/null || true
fi

echo "--> Step 3/3: Packaging Codebase + Database + Documents into single archive..."
tar --exclude='frontend/node_modules' \
    --exclude='backend/.pytest_cache' \
    --exclude='frontend/dist' \
    --exclude='__pycache__' \
    --exclude='.git' \
    --exclude='backups' \
    --exclude='*.tar.gz' \
    --warning=no-file-changed \
    -czf "${BUNDLE_FILE}" \
    . \
    "${STAGING_DIR}" || true

rm -rf "${STAGING_DIR}"

echo "=================================================="
echo "✅ COMPLETE MIGRATION PACKAGE CREATED!"
echo ""
echo "Package File: ${BUNDLE_FILE}"
echo "Location:     $(pwd)/${BUNDLE_FILE}"
echo "Size:         $(du -h "${BUNDLE_FILE}" | cut -f1)"
echo "=================================================="
