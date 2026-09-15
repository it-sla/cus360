# Customer 360 Backend API Reference

This document outlines the core backend API endpoints available on `http://localhost:8000/api/v1` for the new frontend web application.

## 1. Analytics & Executive Dashboard
These endpoints provide aggregated data for dashboards.
* `GET /api/v1/analytics/overview` - Basic summary statistics.
* `GET /api/v1/analytics/dashboard` - Detailed KPIs and charts data.
* `GET /api/v1/analytics/executive-dashboard` - Advanced executive intelligence, AE leaderboard, and dormant customer matrix.
* `GET /api/v1/analytics/customers` - Customer growth metrics.
* `GET /api/v1/analytics/destinations` - Revenue and volume by destination country.
* `GET /api/v1/analytics/bill-types` - Breakdown by billing type.
* `GET /api/v1/analytics/values-by-currency` - Revenue grouped by currency.

## 2. Companies & Customers
* `GET /api/v1/companies` - List all companies (supports search, filtering).
* `GET /api/v1/companies/{company_id}` - Get single company details.
* `GET /api/v1/companies/{company_id}/analytics` - Analytics specific to a company.
* `GET /api/v1/companies/{company_id}/shipments` - List shipments for a company.
* `GET /api/v1/companies/{company_id}/activity` - Recent activity feed.
* `GET /api/v1/companies/{company_id}/documents` - Attached documents and PDFs.
* `GET /api/v1/companies/{company_id}/storage-stats` - Storage usage for documents.
* `PATCH /api/v1/companies/{company_id}` - Update company details.

## 3. Shipments & Packages
* `GET /api/v1/shipments` - List all shipments.
* `GET /api/v1/shipments/{shipment_id}` - Get single shipment.
* `GET /api/v1/shipments/{shipment_id}/packages` - Get packages in a shipment.
* `GET /api/v1/shipments/{shipment_id}/activity` - Shipment event history.
* `GET /api/v1/packages/{package_uuid}` - Get single package.
* `PATCH /api/v1/shipments/{shipment_id}` - Update shipment details.

## 4. CRM Synchronization & Data Quality
* `GET /api/v1/crm-sync/status` - View CRM sync background worker status.
* `GET /api/v1/crm-sync/runs` - History of CRM sync runs.
* `POST /api/v1/crm-sync/sync-now` - Trigger a manual sync.
* `GET /api/v1/data-quality/issues` - View data mismatch or import issues.
* `GET /api/v1/matching-review` - Review fuzzy-matched companies.

## 5. File Imports & Backups
* `POST /api/v1/company-imports` - Upload an Excel manifest.
* `GET /api/v1/company-imports` - View import history.
* `POST /api/v1/admin/backup` - Trigger a database backup.
* `GET /api/v1/admin/backups` - List available backups.

---
**Note:** The API runs on port `8000`. The frontend Vite server should proxy `/api/v1` to `http://127.0.0.1:8000/api/v1` to avoid CORS issues.
