from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://customer360:customer360_dev_password@db:5432/customer360"
    test_database_url: str | None = None
    # B-2: no default on purpose. A hardcoded fallback here is a secret shipped in the
    # repo -- the exact bug being fixed (`"customer360-dev-auth-secret"` was live in
    # every environment that didn't set this). Missing AUTH_SECRET must fail startup,
    # not silently sign every session with a value anyone can read on GitHub.
    auth_secret: str
    backend_cors_origins: str = "http://localhost:5173"
    # Base URL of the frontend app, used to build links (e.g. password-setup links)
    # that a human clicks rather than an API caller — falls back to the first CORS
    # origin, since that's already the frontend's origin in every environment this
    # runs in and avoids a second URL to keep in sync.
    frontend_base_url: str = ""
    max_company_import_mb: int = 25
    max_document_upload_mb: int = 25
    document_storage_root: str = "/data/company-documents"
    crm_scraper_enabled: bool = False
    crm_base_url: str = ""
    crm_login_url: str = ""
    crm_export_manifest_list_url: str = ""
    crm_export_manifest_detail_url_template: str = ""
    crm_import_manifest_list_url: str = ""
    crm_import_manifest_detail_url_template: str = ""
    crm_pnl_url: str = ""
    crm_ups_list_url: str = ""
    crm_ups_detail_url_template: str = ""
    crm_active_pipeline_url: str = ""
    crm_daily_call_logs_url: str = ""
    crm_pipeline_lookahead_days: int = 180
    crm_pipeline_schedule_cron: str = "15 6,12,18 * * *"
    crm_pnl_schedule_cron: str = "30 6,12,18 * * *"
    crm_pnl_schedule_lookback_days: int = 31
    crm_daily_call_logs_schedule_cron: str = "45 6,12,18 * * *"
    crm_daily_call_logs_schedule_lookback_days: int = 7
    crm_username: SecretStr = SecretStr("")
    crm_password: SecretStr = SecretStr("")
    crm_allowed_hosts: str = ""
    crm_headless: bool = True
    crm_request_delay_ms: int = 750
    crm_navigation_timeout_ms: int = 30000
    crm_connect_timeout_ms: int = 10000
    crm_read_timeout_ms: int = 30000
    crm_session_storage_path: str = "/data/crm-session/storage-state.json"
    crm_snapshot_storage_path: str = "/data/crm-snapshots"
    crm_sync_poll_seconds: int = 10
    crm_sync_max_concurrency: int = 1
    crm_sync_max_attempts: int = 5
    crm_sync_lease_seconds: int = 300
    crm_parser_version: str = "2.0.0"
    crm_reconciliation_weight_tolerance: float = 0.01
    crm_default_lookback_days: int = 7
    crm_schedule_enabled: bool = True
    crm_schedule_cron: str = "0 18,21 * * *"
    crm_schedule_overlap_days: int = 14
    crm_raw_snapshot_retention_days: int = 30
    # Gmail SMTP (app password) email digests for Tier Shipping Gap alerts — see
    # docs/customer-segmentation-rules.md. Off by default (the flag and blank
    # username/password all independently short-circuit to a no-op) so this never fires
    # until someone deliberately configures it, and tests never trigger a real send.
    # No domain verification needed (unlike the Resend approach this replaced,
    # 2026-09-03) — a Gmail account already has real sender reputation.
    tier_alert_email_enabled: bool = False
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_username: str = ""
    # An app password, not the account's real login password — generate one at
    # myaccount.google.com/apppasswords (requires 2FA enabled on the Google account).
    smtp_password: SecretStr = SecretStr("")
    smtp_from_email: str = ""  # falls back to smtp_username if unset
    tier_alert_email_schedule_cron: str = "0 8 * * *"
    # Checked more often than the daily digest so a Key Account/Reseller crossing its
    # 7-day SLA gets an urgent one-off email within hours, not the next morning.
    tier_breach_immediate_check_cron: str = "0 */2 * * *"
    weekly_report_email_enabled: bool = False
    weekly_report_email_schedule_cron: str = "15 4 * * 1"  # Monday 10:00 AM NPT (UTC+5:45)
    model_config = SettingsConfigDict(env_file=".env", extra="ignore",case_sensitive=False)
    @property
    def allowed_hosts(self)->set[str]:return {x.strip().lower() for x in self.crm_allowed_hosts.split(',') if x.strip()}
    @property
    def credentials_configured(self)->bool:return bool(self.crm_username.get_secret_value() and self.crm_password.get_secret_value())
settings=Settings()
