"""add resumable per-manifest CRM synchronization

Revision ID: 20260716_0003
Revises: 20260715_0002
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="20260716_0003"; down_revision="20260715_0002"; branch_labels=None; depends_on=None
UUID=postgresql.UUID(as_uuid=True); TZ=sa.DateTime(timezone=True)

def upgrade():
    bind=op.get_bind();inspector=sa.inspect(bind)
    if inspector.has_table('crm_sync_items'):return
    for name,column in [
        ('direction',sa.Column('direction',sa.String(),nullable=False,server_default='export')),
        ('dry_run',sa.Column('dry_run',sa.Boolean(),nullable=False,server_default=sa.false())),
        ('maximum_manifests',sa.Column('maximum_manifests',sa.Integer())),
        ('retry_failed',sa.Column('retry_failed',sa.Boolean(),nullable=False,server_default=sa.false())),
        ('force_reparse',sa.Column('force_reparse',sa.Boolean(),nullable=False,server_default=sa.false())),
        ('discovery_checkpoint',sa.Column('discovery_checkpoint',postgresql.JSONB())),
        ('last_heartbeat_at',sa.Column('last_heartbeat_at',TZ))]:op.add_column('crm_sync_runs',column)
    for table,columns in {
      'master_air_waybills':[sa.Column('manifest_direction',sa.String()),sa.Column('crm_manifest_id',sa.String()),sa.Column('parser_version',sa.String())],
      'shipments':[sa.Column('crm_manifest_id',sa.String()),sa.Column('crm_manifest_direction',sa.String()),sa.Column('crm_parser_version',sa.String())],
      'crm_raw_manifest_headers':[sa.Column('sync_item_id',UUID),sa.Column('crm_manifest_id',sa.String()),sa.Column('parser_version',sa.String())],
      'crm_raw_manifest_rows':[sa.Column('sync_item_id',UUID),sa.Column('crm_manifest_id',sa.String()),sa.Column('parser_version',sa.String())],
      'data_quality_issues':[sa.Column('sync_item_id',UUID)]}.items():
        for column in columns:op.add_column(table,column)
    op.create_index('ix_master_air_waybills_crm_identity','master_air_waybills',['manifest_direction','crm_manifest_id'],unique=True,postgresql_where=sa.text('crm_manifest_id IS NOT NULL'))
    op.create_table('crm_sync_items',
      sa.Column('id',UUID,primary_key=True),sa.Column('run_id',UUID,sa.ForeignKey('crm_sync_runs.id',ondelete='CASCADE'),nullable=False),sa.Column('manifest_direction',sa.String(),nullable=False),sa.Column('crm_manifest_id',sa.String(),nullable=False),sa.Column('source_detail_url',sa.Text()),sa.Column('source_manifest_date',sa.Date()),sa.Column('source_mawb_number',sa.String()),sa.Column('discovery_metadata',postgresql.JSONB()),sa.Column('status',sa.String(),nullable=False,server_default='pending'),sa.Column('attempt_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('maximum_attempts',sa.Integer(),nullable=False,server_default='5'),sa.Column('next_retry_at',TZ),sa.Column('claimed_at',TZ),sa.Column('claimed_by',sa.String()),sa.Column('lease_expires_at',TZ),sa.Column('heartbeat_at',TZ),sa.Column('started_at',TZ),sa.Column('completed_at',TZ),sa.Column('last_error_code',sa.String()),sa.Column('last_error_summary',sa.Text()),sa.Column('parser_version',sa.String()),sa.Column('source_checksum',sa.String()),sa.Column('parsed_row_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('imported_row_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('warning_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('created_mawb_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('updated_mawb_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('created_shipment_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('updated_shipment_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('created_company_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('linked_company_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('blank_icris_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('duplicate_row_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('unchanged',sa.Boolean(),nullable=False,server_default=sa.false()),sa.Column('metrics_json',postgresql.JSONB()),sa.Column('created_at',TZ,nullable=False,server_default=sa.func.now()),sa.Column('updated_at',TZ,nullable=False,server_default=sa.func.now()),sa.UniqueConstraint('run_id','manifest_direction','crm_manifest_id',name='uq_crm_sync_item_identity'))
    for name,cols in [('ix_crm_sync_items_run_id',['run_id']),('ix_crm_sync_items_status',['status']),('ix_crm_sync_items_manifest_id',['crm_manifest_id']),('ix_crm_sync_items_claimed_by',['claimed_by']),('ix_crm_sync_items_source_checksum',['source_checksum'])]:op.create_index(name,'crm_sync_items',cols)
    op.create_index('ix_crm_sync_items_claim','crm_sync_items',['status','next_retry_at','lease_expires_at'])

def downgrade():
    raise RuntimeError('CRM reliability migration downgrade is disabled to preserve synchronization audit data')
