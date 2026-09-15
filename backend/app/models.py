import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

def now() -> datetime: return datetime.now(timezone.utc)
class Base(DeclarativeBase): pass
class UUIDPK:
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
class Timestamps:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

class User(UUIDPK, Timestamps, Base):
    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False, default="user", index=True)
    password_hash: Mapped[str|None] = mapped_column(String, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    ae_code: Mapped[str|None] = mapped_column(String, index=True)
    # First-login / forced-reset password setup. A user created with no password_hash
    # must use setup_token_hash (a one-time, expiring, hashed token — same pattern as
    # session tokens) to set their own password before they can log in at all.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    setup_token_hash: Mapped[str|None] = mapped_column(String, unique=True, index=True)
    setup_token_expires_at: Mapped[datetime|None] = mapped_column(DateTime(timezone=True))

class UserNotificationState(Base):
    """One row per user, tracking which key-insight alert ids they've already seen —
    alert ids are deterministic hashes (see compute_alerts in main.py), so the same
    still-open condition never re-shows as unread just because the page refetched.
    Both seen_alert_ids and snoozed are pruned to currently-live ids on every read
    (see key_insights in main.py) -- so a resolved-then-recurring condition (same id)
    drops out of both and re-alerts, instead of staying "seen" forever.
    snoozed maps id -> ISO date string the snooze/dismiss expires on ("9999-12-31"
    for a permanent dismiss)."""
    __tablename__ = "user_notification_state"
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    seen_alert_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    snoozed: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

class Company(UUIDPK, Timestamps, Base):
    __tablename__="companies"
    icris_number: Mapped[str]=mapped_column(String, nullable=False, unique=True, index=True)
    company_name: Mapped[str]=mapped_column(String, nullable=False, index=True)
    normalized_name: Mapped[str]=mapped_column(String, nullable=False, index=True)
    legal_name: Mapped[str|None]=mapped_column(String)
    phone: Mapped[str|None]=mapped_column(String, index=True)
    email: Mapped[str|None]=mapped_column(String, index=True)
    address: Mapped[str|None]=mapped_column(Text)
    pan_vat_number: Mapped[str|None]=mapped_column(String, index=True)
    customer_type: Mapped[str|None]=mapped_column(String)
    status: Mapped[str]=mapped_column(String, default="active")
    notes: Mapped[str|None]=mapped_column(Text)
    source: Mapped[str]=mapped_column(String, default="manual")
    is_provisional: Mapped[bool]=mapped_column(Boolean,default=False)
    crm_customer_id: Mapped[str|None]=mapped_column(String,index=True)
    crm_last_synced_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    name_source: Mapped[str|None]=mapped_column(String)
    manual_override_fields: Mapped[list[str]]=mapped_column(JSONB,default=list)
    last_company_import_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    last_company_import_batch_id: Mapped[uuid.UUID|None]=mapped_column(UUID(as_uuid=True))
    assigned_ae_code: Mapped[str|None]=mapped_column(String,index=True)
    ae_assigned_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    aliases: Mapped[list["CompanyAlias"]]=relationship(back_populates="company", cascade="all, delete-orphan")
    shipments: Mapped[list["Shipment"]]=relationship(back_populates="company")
    documents: Mapped[list["CompanyDocument"]]=relationship(back_populates="company")

class AccountExecutive(UUIDPK, Timestamps, Base):
    __tablename__="account_executives"
    ae_code: Mapped[str]=mapped_column(String,nullable=False,unique=True,index=True)
    display_name: Mapped[str|None]=mapped_column(String)
    is_active: Mapped[bool]=mapped_column(Boolean,default=True)

class AeReassignmentLog(UUIDPK, Base):
    __tablename__="ae_reassignment_log"
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    company_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("companies.id",ondelete="CASCADE"),index=True)
    from_ae_code: Mapped[str|None]=mapped_column(String)
    to_ae_code: Mapped[str|None]=mapped_column(String)
    reason: Mapped[str|None]=mapped_column(String)
    source: Mapped[str]=mapped_column(String,default="manual")
    changed_by_user_id: Mapped[uuid.UUID|None]=mapped_column(UUID(as_uuid=True),ForeignKey("users.id"))
    shipments_updated: Mapped[int]=mapped_column(Integer,default=0)

class AeImportBatch(UUIDPK, Base):
    __tablename__="ae_import_batches"
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    updated_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,onupdate=now)
    file_name: Mapped[str]=mapped_column(String)
    file_hash: Mapped[str]=mapped_column(String,index=True)
    worksheet_name: Mapped[str|None]=mapped_column(String)
    total_rows: Mapped[int]=mapped_column(Integer,default=0)
    matched_count: Mapped[int]=mapped_column(Integer,default=0)
    reassigned_count: Mapped[int]=mapped_column(Integer,default=0)
    unchanged_count: Mapped[int]=mapped_column(Integer,default=0)
    unmatched_icris_count: Mapped[int]=mapped_column(Integer,default=0)
    unknown_ae_count: Mapped[int]=mapped_column(Integer,default=0)
    invalid_row_count: Mapped[int]=mapped_column(Integer,default=0)
    status: Mapped[str]=mapped_column(String,default="pending")
    completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))

class AeImportRow(UUIDPK, Base):
    __tablename__="ae_import_rows"
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    import_batch_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("ae_import_batches.id",ondelete="CASCADE"),index=True)
    row_number: Mapped[int]=mapped_column(Integer)
    raw_data_json: Mapped[dict[str,Any]]=mapped_column(JSONB)
    processing_status: Mapped[str]=mapped_column(String)
    error_message: Mapped[str|None]=mapped_column(Text)
    company_id: Mapped[uuid.UUID|None]=mapped_column(UUID(as_uuid=True),ForeignKey("companies.id"))

class CompanyAlias(UUIDPK, Base):
    __tablename__="company_aliases"; __table_args__=(UniqueConstraint("company_id","normalized_alias_name"),)
    company_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    alias_name: Mapped[str]=mapped_column(String)
    normalized_alias_name: Mapped[str]=mapped_column(String, index=True)
    source: Mapped[str]=mapped_column(String, default="manual")
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)
    company: Mapped[Company]=relationship(back_populates="aliases")

class CompanyImportBatch(UUIDPK, Base):
    __tablename__="company_import_batches"
    file_name: Mapped[str]=mapped_column(String); file_hash: Mapped[str]=mapped_column(String,index=True); worksheet_name: Mapped[str|None]=mapped_column(String); mapping_json: Mapped[dict[str,Any]|None]=mapped_column(JSONB)
    total_rows: Mapped[int]=mapped_column(Integer, default=0); created_count: Mapped[int]=mapped_column(Integer, default=0)
    updated_count: Mapped[int]=mapped_column(Integer, default=0); skipped_count: Mapped[int]=mapped_column(Integer, default=0)
    failed_count: Mapped[int]=mapped_column(Integer, default=0); status: Mapped[str]=mapped_column(String, default="pending")
    valid_count: Mapped[int]=mapped_column(Integer,default=0); blank_icris_count: Mapped[int]=mapped_column(Integer,default=0); blank_name_count: Mapped[int]=mapped_column(Integer,default=0); unique_icris_count: Mapped[int]=mapped_column(Integer,default=0); duplicate_group_count: Mapped[int]=mapped_column(Integer,default=0); promoted_count: Mapped[int]=mapped_column(Integer,default=0); alias_added_count: Mapped[int]=mapped_column(Integer,default=0); unchanged_count: Mapped[int]=mapped_column(Integer,default=0); conflict_count: Mapped[int]=mapped_column(Integer,default=0); rejected_count: Mapped[int]=mapped_column(Integer,default=0)
    started_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now); completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    error_message: Mapped[str|None]=mapped_column(Text); created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)
    rows: Mapped[list["CompanyImportRawRow"]]=relationship(cascade="all, delete-orphan")
class CompanyImportRawRow(UUIDPK, Base):
    __tablename__="company_import_raw_rows"
    import_batch_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("company_import_batches.id", ondelete="CASCADE"), index=True)
    row_number: Mapped[int]=mapped_column(Integer); raw_data_json: Mapped[dict[str,Any]]=mapped_column(JSONB)
    processing_status: Mapped[str]=mapped_column(String); error_message: Mapped[str|None]=mapped_column(Text)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class ManifestImportBatch(UUIDPK, Base):
    __tablename__="manifest_import_batches"
    file_name: Mapped[str]=mapped_column(String); file_hash: Mapped[str]=mapped_column(String, unique=True, index=True)
    file_type: Mapped[str]=mapped_column(String); worksheet_name: Mapped[str|None]=mapped_column(String); import_mode: Mapped[str]=mapped_column(String, default="skip_existing")
    total_rows: Mapped[int]=mapped_column(Integer, default=0); shipment_count: Mapped[int]=mapped_column(Integer, default=0); package_count: Mapped[int]=mapped_column(Integer, default=0)
    created_shipments: Mapped[int]=mapped_column(Integer, default=0); updated_shipments: Mapped[int]=mapped_column(Integer, default=0); skipped_shipments: Mapped[int]=mapped_column(Integer, default=0)
    matched_count: Mapped[int]=mapped_column(Integer, default=0); suggested_count: Mapped[int]=mapped_column(Integer, default=0); unmatched_count: Mapped[int]=mapped_column(Integer, default=0)
    warning_count: Mapped[int]=mapped_column(Integer, default=0); failed_count: Mapped[int]=mapped_column(Integer, default=0); status: Mapped[str]=mapped_column(String, default="pending")
    started_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now); completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True)); error_message: Mapped[str|None]=mapped_column(Text)
    created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)
class ManifestRawRow(UUIDPK, Base):
    __tablename__="manifest_raw_rows"
    import_batch_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("manifest_import_batches.id", ondelete="CASCADE"), index=True)
    row_number: Mapped[int]=mapped_column(Integer); shipment_number: Mapped[str|None]=mapped_column(String); package_id: Mapped[str|None]=mapped_column(String)
    raw_data_json: Mapped[dict[str,Any]]=mapped_column(JSONB); processing_status: Mapped[str]=mapped_column(String)
    warning_messages: Mapped[list[str]|None]=mapped_column(JSONB); error_message: Mapped[str|None]=mapped_column(Text); created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True), default=now)

class Shipment(UUIDPK, Timestamps, Base):
    __tablename__="shipments"
    company_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("companies.id"), index=True); shipment_number: Mapped[str]=mapped_column(String, unique=True, index=True); shipment_date: Mapped[date|None]=mapped_column(Date)
    pieces: Mapped[int|None]=mapped_column(Integer); shipment_weight: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); weight_unit: Mapped[str|None]=mapped_column(String)
    bill_type: Mapped[str|None]=mapped_column(String,index=True); billing_term: Mapped[str|None]=mapped_column(String,index=True); declared_value: Mapped[Decimal|None]=mapped_column(Numeric(16,2)); value_currency: Mapped[str|None]=mapped_column(String,index=True); tnd_value: Mapped[Decimal|None]=mapped_column(Numeric(16,2))
    shipper_name: Mapped[str|None]=mapped_column(String,index=True); shipper_address_1: Mapped[str|None]=mapped_column(String); shipper_address_2: Mapped[str|None]=mapped_column(String); shipper_address_3: Mapped[str|None]=mapped_column(String); shipper_postal_code: Mapped[str|None]=mapped_column(String); shipper_city: Mapped[str|None]=mapped_column(String); export_country: Mapped[str|None]=mapped_column(String,index=True)
    importer_name: Mapped[str|None]=mapped_column(String,index=True); importer_address_1: Mapped[str|None]=mapped_column(String); importer_address_2: Mapped[str|None]=mapped_column(String); importer_address_3: Mapped[str|None]=mapped_column(String); importer_postal_code: Mapped[str|None]=mapped_column(String); importer_city: Mapped[str|None]=mapped_column(String); import_country: Mapped[str|None]=mapped_column(String,index=True); importer_telephone: Mapped[str|None]=mapped_column(String,index=True)
    goods_description: Mapped[str|None]=mapped_column(Text); source: Mapped[str]=mapped_column(String, default="manual"); manifest_batch_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("manifest_import_batches.id"), index=True)
    match_status: Mapped[str]=mapped_column(String,default="unmatched",index=True); match_confidence: Mapped[Decimal|None]=mapped_column(Numeric(5,2)); matched_by_method: Mapped[str]=mapped_column(String,default="none"); manually_matched: Mapped[bool]=mapped_column(Boolean,default=False)
    mawb_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("master_air_waybills.id"),index=True)
    source_icris_number: Mapped[str|None]=mapped_column(String,index=True)
    source_customer_name: Mapped[str|None]=mapped_column(String)
    crm_source_key: Mapped[str|None]=mapped_column(String,index=True)
    crm_source_url: Mapped[str|None]=mapped_column(Text)
    crm_last_synced_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    crm_manifest_id: Mapped[str|None]=mapped_column(String,index=True)
    crm_manifest_direction: Mapped[str|None]=mapped_column(String)
    crm_parser_version: Mapped[str|None]=mapped_column(String)
    manual_override_fields: Mapped[list[str]]=mapped_column(JSONB,default=list)
    crm_field_provenance: Mapped[dict[str,Any]]=mapped_column(JSONB,default=dict)
    actual_weight: Mapped[Decimal|None]=mapped_column(Numeric(16,3))
    dimensional_weight: Mapped[Decimal|None]=mapped_column(Numeric(16,3))
    pay_term: Mapped[str|None]=mapped_column(String,index=True)
    bill_number: Mapped[str|None]=mapped_column(String,index=True)
    bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2))
    gross_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2))
    tariff_rate: Mapped[Decimal|None]=mapped_column(Numeric(18,6))
    ae_code: Mapped[str|None]=mapped_column(String)
    pnl_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); pnl_ups_discount_percent: Mapped[Decimal|None]=mapped_column(Numeric(6,2)); pnl_ups_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); pnl_profit_loss: Mapped[Decimal|None]=mapped_column(Numeric(18,2))
    pnl_bill_number: Mapped[str|None]=mapped_column(String); pnl_synced_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True),index=True)
    delivery_code: Mapped[str|None]=mapped_column(String)
    name_mismatch: Mapped[bool]=mapped_column(Boolean,default=False)
    is_manually_matched: Mapped[bool]=mapped_column(Boolean,default=False)
    company: Mapped[Company|None]=relationship(back_populates="shipments"); packages: Mapped[list["Package"]]=relationship(back_populates="shipment", cascade="all, delete-orphan")
    __table_args__=(Index("ix_shipments_imported", "created_at"),)

class MasterAirWaybill(UUIDPK,Timestamps,Base):
    __tablename__="master_air_waybills"; __table_args__=(UniqueConstraint("mawb_number","manifest_date",name="uq_mawb_number_date"),)
    mawb_number: Mapped[str]=mapped_column(String,index=True); manifest_date: Mapped[date]=mapped_column(Date,index=True)
    flight_number: Mapped[str|None]=mapped_column(String,index=True); origin: Mapped[str|None]=mapped_column(String,index=True); destination: Mapped[str|None]=mapped_column(String,index=True)
    exchange_rate: Mapped[Decimal|None]=mapped_column(Numeric(18,6)); fuel_surcharge: Mapped[Decimal|None]=mapped_column(Numeric(18,6))
    pp_weight: Mapped[Decimal|None]=mapped_column(Numeric(16,3)); fc_weight: Mapped[Decimal|None]=mapped_column(Numeric(16,3)); fd_weight: Mapped[Decimal|None]=mapped_column(Numeric(16,3))
    pp_pieces: Mapped[int|None]=mapped_column(Integer); fc_pieces: Mapped[int|None]=mapped_column(Integer); fd_pieces: Mapped[int|None]=mapped_column(Integer)
    pp_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); fc_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); fd_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2))
    pp_gross_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); fc_gross_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); fd_gross_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2))
    source_system: Mapped[str]=mapped_column(String,default="crm"); source_key: Mapped[str|None]=mapped_column(String); source_url: Mapped[str|None]=mapped_column(Text); source_checksum: Mapped[str|None]=mapped_column(String,index=True); last_synced_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    manifest_direction: Mapped[str|None]=mapped_column(String,index=True); crm_manifest_id: Mapped[str|None]=mapped_column(String,index=True); parser_version: Mapped[str|None]=mapped_column(String)
    pnl_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); pnl_ups_bill_amount: Mapped[Decimal|None]=mapped_column(Numeric(18,2)); pnl_profit_loss: Mapped[Decimal|None]=mapped_column(Numeric(18,2))
    pnl_source_checksum: Mapped[str|None]=mapped_column(String,index=True); pnl_synced_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    ups_crm_record_id: Mapped[str|None]=mapped_column(String,index=True); ups_detail_synced_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))

class CrmSyncRun(UUIDPK,Timestamps,Base):
    __tablename__="crm_sync_runs"
    sync_type: Mapped[str]=mapped_column(String); status: Mapped[str]=mapped_column(String,default="queued",index=True); requested_from_date: Mapped[date|None]=mapped_column(Date); requested_to_date: Mapped[date|None]=mapped_column(Date); requested_mawb: Mapped[str|None]=mapped_column(String)
    started_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True)); completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    list_pages_read: Mapped[int]=mapped_column(Integer,default=0); detail_pages_read: Mapped[int]=mapped_column(Integer,default=0); mawbs_found: Mapped[int]=mapped_column(Integer,default=0); mawbs_created: Mapped[int]=mapped_column(Integer,default=0); mawbs_updated: Mapped[int]=mapped_column(Integer,default=0); shipments_found: Mapped[int]=mapped_column(Integer,default=0); shipments_created: Mapped[int]=mapped_column(Integer,default=0); shipments_updated: Mapped[int]=mapped_column(Integer,default=0); companies_created: Mapped[int]=mapped_column(Integer,default=0); companies_updated: Mapped[int]=mapped_column(Integer,default=0); matched_by_icris: Mapped[int]=mapped_column(Integer,default=0); missing_icris: Mapped[int]=mapped_column(Integer,default=0); warnings_count: Mapped[int]=mapped_column(Integer,default=0); failed_count: Mapped[int]=mapped_column(Integer,default=0)
    error_message: Mapped[str|None]=mapped_column(Text); worker_id: Mapped[str|None]=mapped_column(String)
    direction: Mapped[str]=mapped_column(String,default="export"); dry_run: Mapped[bool]=mapped_column(Boolean,default=False); maximum_manifests: Mapped[int|None]=mapped_column(Integer); retry_failed: Mapped[bool]=mapped_column(Boolean,default=False); force_reparse: Mapped[bool]=mapped_column(Boolean,default=False); discovery_checkpoint: Mapped[dict[str,Any]|None]=mapped_column(JSONB); last_heartbeat_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))

class CrmSyncItem(UUIDPK,Timestamps,Base):
    __tablename__="crm_sync_items"; __table_args__=(UniqueConstraint("run_id","manifest_direction","crm_manifest_id",name="uq_crm_sync_item_identity"),Index("ix_crm_sync_items_claim","status","next_retry_at","lease_expires_at"))
    run_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("crm_sync_runs.id",ondelete="CASCADE"),index=True)
    manifest_direction: Mapped[str]=mapped_column(String,index=True); crm_manifest_id: Mapped[str]=mapped_column(String,index=True); source_detail_url: Mapped[str|None]=mapped_column(Text)
    source_manifest_date: Mapped[date|None]=mapped_column(Date); source_mawb_number: Mapped[str|None]=mapped_column(String); discovery_metadata: Mapped[dict[str,Any]|None]=mapped_column(JSONB)
    status: Mapped[str]=mapped_column(String,default="pending",index=True); attempt_count: Mapped[int]=mapped_column(Integer,default=0); maximum_attempts: Mapped[int]=mapped_column(Integer,default=5); next_retry_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True),index=True)
    claimed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True)); claimed_by: Mapped[str|None]=mapped_column(String,index=True); lease_expires_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True),index=True); heartbeat_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True)); started_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True)); completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    last_error_code: Mapped[str|None]=mapped_column(String,index=True); last_error_summary: Mapped[str|None]=mapped_column(Text); parser_version: Mapped[str|None]=mapped_column(String); source_checksum: Mapped[str|None]=mapped_column(String,index=True)
    parsed_row_count: Mapped[int]=mapped_column(Integer,default=0); imported_row_count: Mapped[int]=mapped_column(Integer,default=0); warning_count: Mapped[int]=mapped_column(Integer,default=0); created_mawb_count: Mapped[int]=mapped_column(Integer,default=0); updated_mawb_count: Mapped[int]=mapped_column(Integer,default=0); created_shipment_count: Mapped[int]=mapped_column(Integer,default=0); updated_shipment_count: Mapped[int]=mapped_column(Integer,default=0); created_company_count: Mapped[int]=mapped_column(Integer,default=0); linked_company_count: Mapped[int]=mapped_column(Integer,default=0); blank_icris_count: Mapped[int]=mapped_column(Integer,default=0); duplicate_row_count: Mapped[int]=mapped_column(Integer,default=0); unchanged: Mapped[bool]=mapped_column(Boolean,default=False); metrics_json: Mapped[dict[str,Any]|None]=mapped_column(JSONB)

class CrmSyncState(UUIDPK,Base):
    __tablename__="crm_sync_state"
    entity_type: Mapped[str]=mapped_column(String,unique=True); last_successful_date: Mapped[date|None]=mapped_column(Date); last_successful_sync_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True)); last_sync_run_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("crm_sync_runs.id")); cursor_json: Mapped[dict[str,Any]|None]=mapped_column(JSONB); updated_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,onupdate=now)

class CrmBackfillRun(UUIDPK,Base):
    __tablename__='crm_backfill_runs'
    direction: Mapped[str]=mapped_column(String,index=True);requested_start_date: Mapped[date|None]=mapped_column(Date);requested_end_date: Mapped[date]=mapped_column(Date);resolved_start_date: Mapped[date]=mapped_column(Date);resolved_end_date: Mapped[date]=mapped_column(Date);chunk_size_days: Mapped[int]=mapped_column(Integer,default=7);mode: Mapped[str]=mapped_column(String);status: Mapped[str]=mapped_column(String,default='draft',index=True);current_chunk_start: Mapped[date|None]=mapped_column(Date);current_chunk_end: Mapped[date|None]=mapped_column(Date);total_chunks: Mapped[int]=mapped_column(Integer,default=0);completed_chunks: Mapped[int]=mapped_column(Integer,default=0);failed_chunks: Mapped[int]=mapped_column(Integer,default=0);total_manifests_discovered: Mapped[int]=mapped_column(Integer,default=0);total_manifests_processed: Mapped[int]=mapped_column(Integer,default=0);succeeded_manifests: Mapped[int]=mapped_column(Integer,default=0);warning_manifests: Mapped[int]=mapped_column(Integer,default=0);quarantined_manifests: Mapped[int]=mapped_column(Integer,default=0);skipped_unchanged_manifests: Mapped[int]=mapped_column(Integer,default=0);created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now);started_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True));paused_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True));completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True));last_heartbeat_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True));created_by_source: Mapped[str]=mapped_column(String,default='manual');last_error_code: Mapped[str|None]=mapped_column(String);last_error_summary: Mapped[str|None]=mapped_column(Text)
class CrmBackfillChunk(UUIDPK,Base):
    __tablename__='crm_backfill_chunks';__table_args__=(UniqueConstraint('backfill_id','direction','date_from','date_to',name='uq_crm_backfill_chunk_range'),)
    backfill_id: Mapped[uuid.UUID]=mapped_column(ForeignKey('crm_backfill_runs.id',ondelete='CASCADE'),index=True);direction: Mapped[str]=mapped_column(String,index=True);date_from: Mapped[date]=mapped_column(Date);date_to: Mapped[date]=mapped_column(Date);sequence_number: Mapped[int]=mapped_column(Integer);status: Mapped[str]=mapped_column(String,default='pending',index=True);sync_run_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey('crm_sync_runs.id'));attempt_count: Mapped[int]=mapped_column(Integer,default=0);checkpoint_json: Mapped[dict[str,Any]|None]=mapped_column(JSONB);manifest_count: Mapped[int]=mapped_column(Integer,default=0);completed_manifest_count: Mapped[int]=mapped_column(Integer,default=0);warning_count: Mapped[int]=mapped_column(Integer,default=0);quarantined_count: Mapped[int]=mapped_column(Integer,default=0);started_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True));completed_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True));last_error_code: Mapped[str|None]=mapped_column(String);last_error_summary: Mapped[str|None]=mapped_column(Text);created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)

class CrmRawManifestHeader(UUIDPK,Base):
    __tablename__="crm_raw_manifest_headers"
    sync_run_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("crm_sync_runs.id"),index=True); master_air_waybill_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("master_air_waybills.id")); mawb_number: Mapped[str|None]=mapped_column(String); manifest_date: Mapped[date|None]=mapped_column(Date); source_url: Mapped[str|None]=mapped_column(Text); source_headers_json: Mapped[dict[str,Any]]=mapped_column(JSONB); raw_values_json: Mapped[dict[str,Any]]=mapped_column(JSONB); source_checksum: Mapped[str]=mapped_column(String,index=True); processing_status: Mapped[str]=mapped_column(String); warning_messages: Mapped[list[str]|None]=mapped_column(JSONB); error_message: Mapped[str|None]=mapped_column(Text); created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    sync_item_id: Mapped[uuid.UUID|None]=mapped_column(UUID(as_uuid=True),index=True); crm_manifest_id: Mapped[str|None]=mapped_column(String); parser_version: Mapped[str|None]=mapped_column(String)

class CrmRawManifestRow(UUIDPK,Base):
    __tablename__="crm_raw_manifest_rows"
    sync_run_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("crm_sync_runs.id"),index=True); master_air_waybill_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("master_air_waybills.id")); shipment_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("shipments.id")); source_row_number: Mapped[int]=mapped_column(Integer); tracking_number: Mapped[str|None]=mapped_column(String,index=True); source_icris_number: Mapped[str|None]=mapped_column(String,index=True); source_headers_json: Mapped[list[str]]=mapped_column(JSONB); raw_values_json: Mapped[dict[str,Any]]=mapped_column(JSONB); source_checksum: Mapped[str]=mapped_column(String,index=True); processing_status: Mapped[str]=mapped_column(String); warning_messages: Mapped[list[str]|None]=mapped_column(JSONB); error_message: Mapped[str|None]=mapped_column(Text); created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    sync_item_id: Mapped[uuid.UUID|None]=mapped_column(UUID(as_uuid=True),index=True); crm_manifest_id: Mapped[str|None]=mapped_column(String); parser_version: Mapped[str|None]=mapped_column(String)

class DataQualityIssue(UUIDPK,Timestamps,Base):
    __tablename__="data_quality_issues"
    issue_type: Mapped[str]=mapped_column(String,index=True); severity: Mapped[str]=mapped_column(String); company_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("companies.id")); shipment_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("shipments.id")); mawb_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("master_air_waybills.id")); sync_run_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("crm_sync_runs.id")); source_icris_number: Mapped[str|None]=mapped_column(String); source_company_name: Mapped[str|None]=mapped_column(String); details_json: Mapped[dict[str,Any]]=mapped_column(JSONB,default=dict); status: Mapped[str]=mapped_column(String,default="open",index=True); first_seen_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now); last_seen_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now); resolved_at: Mapped[datetime|None]=mapped_column(DateTime(timezone=True))
    sync_item_id: Mapped[uuid.UUID|None]=mapped_column(UUID(as_uuid=True),index=True)
    # 'crm_sync' / 'company_master_import' for automatic resolution, or the admin's email
    # for a manual Resolve/Ignore click. Lets the Resolution Log tell the two apart —
    # previously both collapsed into status='resolved' with no way to know which happened.
    resolved_by: Mapped[str|None]=mapped_column(String)
class Package(UUIDPK, Timestamps, Base):
    __tablename__="packages"
    shipment_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("shipments.id",ondelete="CASCADE"),index=True); package_id: Mapped[str]=mapped_column(String,unique=True,index=True); piece_number: Mapped[int]=mapped_column(Integer)
    package_weight: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); weight_unit: Mapped[str|None]=mapped_column(String); package_type: Mapped[str|None]=mapped_column(String); description: Mapped[str|None]=mapped_column(Text)
    length_cm: Mapped[Decimal|None]=mapped_column(Numeric(12,2)); width_cm: Mapped[Decimal|None]=mapped_column(Numeric(12,2)); height_cm: Mapped[Decimal|None]=mapped_column(Numeric(12,2)); dimensional_weight: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); chargeable_weight: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); barcode: Mapped[str|None]=mapped_column(String,index=True); package_status: Mapped[str|None]=mapped_column(String); remarks: Mapped[str|None]=mapped_column(Text)
    shipment: Mapped[Shipment]=relationship(back_populates="packages")

class CompanyDocument(UUIDPK, Base):
    __tablename__="company_documents"
    company_id: Mapped[uuid.UUID]=mapped_column(ForeignKey("companies.id"),index=True); title: Mapped[str]=mapped_column(String,index=True); original_file_name: Mapped[str]=mapped_column(String); stored_file_name: Mapped[str]=mapped_column(String,unique=True); relative_storage_path: Mapped[str]=mapped_column(String,unique=True)
    mime_type: Mapped[str]=mapped_column(String); file_extension: Mapped[str|None]=mapped_column(String); file_size_bytes: Mapped[int]=mapped_column(BigInteger); category: Mapped[str]=mapped_column(String,index=True); description: Mapped[str|None]=mapped_column(Text); tags: Mapped[list[str]]=mapped_column(JSONB,default=list); document_date: Mapped[date|None]=mapped_column(Date); version_number: Mapped[int]=mapped_column(Integer,default=1); status: Mapped[str]=mapped_column(String,default="active"); checksum_sha256: Mapped[str]=mapped_column(String,index=True); replaces_document_id: Mapped[uuid.UUID|None]=mapped_column(ForeignKey("company_documents.id")); uploaded_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now); updated_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,onupdate=now)
    company: Mapped[Company]=relationship(back_populates="documents")
class AeTarget(UUIDPK, Timestamps, Base):
    __tablename__="ae_targets"; __table_args__=(UniqueConstraint("ae_code","year","month",name="uq_ae_target_period"),)
    ae_code: Mapped[str]=mapped_column(String,index=True); year: Mapped[int]=mapped_column(Integer,index=True); month: Mapped[int]=mapped_column(Integer)
    weight_target: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); piece_target: Mapped[int|None]=mapped_column(Integer); revenue_target: Mapped[Decimal|None]=mapped_column(Numeric(16,2))
    weight_target_import: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); piece_target_import: Mapped[int|None]=mapped_column(Integer); revenue_target_import: Mapped[Decimal|None]=mapped_column(Numeric(16,2))
    source: Mapped[str]=mapped_column(String,default="manual"); notes: Mapped[str|None]=mapped_column(Text)

class PipelineItem(UUIDPK, Timestamps, Base):
    __tablename__="pipeline_items"
    expected_date: Mapped[date]=mapped_column(Date,index=True); company_name: Mapped[str]=mapped_column(String,index=True); icris_number: Mapped[str|None]=mapped_column(String,index=True); country: Mapped[str|None]=mapped_column(String)
    weight_kg: Mapped[Decimal|None]=mapped_column(Numeric(14,3)); revenue_usd: Mapped[Decimal|None]=mapped_column(Numeric(16,2)); pieces: Mapped[int|None]=mapped_column(Integer); category: Mapped[str|None]=mapped_column(String,index=True)
    ae_code: Mapped[str|None]=mapped_column(String,index=True); win_loss: Mapped[str|None]=mapped_column(String,index=True); remarks: Mapped[str|None]=mapped_column(Text); source_detail_ref: Mapped[str|None]=mapped_column(Text)
    scraped_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)

class DailyCallLog(UUIDPK, Base):
    __tablename__="daily_call_logs"
    call_date: Mapped[date]=mapped_column(Date,index=True)
    company_name: Mapped[str]=mapped_column(String,index=True)
    normalized_company_name: Mapped[str|None]=mapped_column(String,index=True)
    crm_customer_id: Mapped[str|None]=mapped_column(String,index=True)
    stage: Mapped[str|None]=mapped_column(String)
    category: Mapped[str|None]=mapped_column(String,index=True)
    contact_person: Mapped[str|None]=mapped_column(String)
    phone: Mapped[str|None]=mapped_column(String)
    call_type: Mapped[str|None]=mapped_column(String)
    ae_code: Mapped[str|None]=mapped_column(String,index=True)
    remarks: Mapped[str|None]=mapped_column(Text)
    supervisor_comment: Mapped[str|None]=mapped_column(Text)
    follow_up_date: Mapped[date|None]=mapped_column(Date)
    source_row_hash: Mapped[str]=mapped_column(String,unique=True,index=True)
    scraped_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)

class ActivityLog(UUIDPK, Base):
    __tablename__="activity_logs"
    entity_type: Mapped[str]=mapped_column(String,index=True); entity_id: Mapped[uuid.UUID]=mapped_column(UUID(as_uuid=True),index=True); action: Mapped[str]=mapped_column(String); description: Mapped[str]=mapped_column(Text); source: Mapped[str]=mapped_column(String); metadata_json: Mapped[dict[str,Any]|None]=mapped_column(JSONB); created_at: Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
