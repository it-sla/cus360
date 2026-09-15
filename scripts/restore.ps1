# Courier Intelligence — Windows PowerShell Restore Script
Param(
    [string]$ArchivePath = ""
)

if ($ArchivePath -eq "") {
    Write-Host "Usage: .\scripts\restore.ps1 <path-to-backup.tar.gz>" -ForegroundColor Yellow
    Exit 1
}

if (!(Test-Path $ArchivePath)) {
    Write-Host "Error: Archive file '$ArchivePath' not found." -ForegroundColor Red
    Exit 1
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "📦 Courier Intelligence Windows Restore System" -ForegroundColor Cyan
Write-Host "Archive: $ArchivePath" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# 1. Unpack backup
Write-Host "--> Extracting backup archive..." -ForegroundColor Green
mkdir -Force "backups\temp_restore" | Out-Null
tar -xzf $ArchivePath -C "backups\temp_restore"

$BundleDir = Get-ChildItem "backups\temp_restore" | Where-Object { $_.PSIsContainer } | Select-Object -First 1

# 2. Restore PostgreSQL Database
if (Test-Path "$($BundleDir.FullName)\database.sql.gz") {
    Write-Host "--> Restoring PostgreSQL database..." -ForegroundColor Green
    docker compose exec -T db sh -c "gunzip -c" < "$($BundleDir.FullName)\database.sql.gz" | docker compose exec -T db psql -U customer360 -d customer360
}

# 3. Restore Company Documents
if (Test-Path "$($BundleDir.FullName)\company_documents.tar.gz") {
    Write-Host "--> Restoring company documents..." -ForegroundColor Green
    docker compose exec -T backend tar -xzf - -C /data/company-documents < "$($BundleDir.FullName)\company_documents.tar.gz"
}

# Cleanup temp
Remove-Item -Recurse -Force "backups\temp_restore"

Write-Host "==================================================" -ForegroundColor Green
Write-Host "✅ Restore completed successfully on Windows!" -ForegroundColor Green
Write-Host "Open http://localhost:5173 in your browser." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
