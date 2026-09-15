"""historical CRM backfills and rolling chunks

Revision ID: 20260716_0008
Revises: 20260716_0007
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision='20260716_0008';down_revision='20260716_0007';branch_labels=None;depends_on=None
UUID=postgresql.UUID(as_uuid=True);TZ=sa.DateTime(timezone=True)
def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('crm_backfill_runs'):
        op.create_table('crm_backfill_runs',sa.Column('id',UUID,primary_key=True),sa.Column('direction',sa.String(),nullable=False),sa.Column('requested_start_date',sa.Date()),sa.Column('requested_end_date',sa.Date(),nullable=False),sa.Column('resolved_start_date',sa.Date(),nullable=False),sa.Column('resolved_end_date',sa.Date(),nullable=False),sa.Column('chunk_size_days',sa.Integer(),nullable=False,server_default='7'),sa.Column('mode',sa.String(),nullable=False),sa.Column('status',sa.String(),nullable=False,server_default='draft'),sa.Column('current_chunk_start',sa.Date()),sa.Column('current_chunk_end',sa.Date()),sa.Column('total_chunks',sa.Integer(),nullable=False,server_default='0'),sa.Column('completed_chunks',sa.Integer(),nullable=False,server_default='0'),sa.Column('failed_chunks',sa.Integer(),nullable=False,server_default='0'),sa.Column('total_manifests_discovered',sa.Integer(),nullable=False,server_default='0'),sa.Column('total_manifests_processed',sa.Integer(),nullable=False,server_default='0'),sa.Column('succeeded_manifests',sa.Integer(),nullable=False,server_default='0'),sa.Column('warning_manifests',sa.Integer(),nullable=False,server_default='0'),sa.Column('quarantined_manifests',sa.Integer(),nullable=False,server_default='0'),sa.Column('skipped_unchanged_manifests',sa.Integer(),nullable=False,server_default='0'),sa.Column('created_at',TZ,nullable=False),sa.Column('started_at',TZ),sa.Column('paused_at',TZ),sa.Column('completed_at',TZ),sa.Column('last_heartbeat_at',TZ),sa.Column('created_by_source',sa.String(),nullable=False,server_default='manual'),sa.Column('last_error_code',sa.String()),sa.Column('last_error_summary',sa.Text()))
        op.create_index('ix_crm_backfill_runs_status','crm_backfill_runs',['status']);op.create_index('ix_crm_backfill_runs_direction','crm_backfill_runs',['direction'])
    if not inspector.has_table('crm_backfill_chunks'):
        op.create_table('crm_backfill_chunks',sa.Column('id',UUID,primary_key=True),sa.Column('backfill_id',UUID,sa.ForeignKey('crm_backfill_runs.id',ondelete='CASCADE'),nullable=False),sa.Column('direction',sa.String(),nullable=False),sa.Column('date_from',sa.Date(),nullable=False),sa.Column('date_to',sa.Date(),nullable=False),sa.Column('sequence_number',sa.Integer(),nullable=False),sa.Column('status',sa.String(),nullable=False,server_default='pending'),sa.Column('sync_run_id',UUID,sa.ForeignKey('crm_sync_runs.id')),sa.Column('attempt_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('checkpoint_json',postgresql.JSONB()),sa.Column('manifest_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('completed_manifest_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('warning_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('quarantined_count',sa.Integer(),nullable=False,server_default='0'),sa.Column('started_at',TZ),sa.Column('completed_at',TZ),sa.Column('last_error_code',sa.String()),sa.Column('last_error_summary',sa.Text()),sa.Column('created_at',TZ,nullable=False),sa.UniqueConstraint('backfill_id','direction','date_from','date_to',name='uq_crm_backfill_chunk_range'))
        op.create_index('ix_crm_backfill_chunks_backfill_id','crm_backfill_chunks',['backfill_id']);op.create_index('ix_crm_backfill_chunks_status','crm_backfill_chunks',['status']);op.create_index('ix_crm_backfill_chunks_direction','crm_backfill_chunks',['direction'])
def downgrade():raise RuntimeError('Backfill downgrade is disabled to preserve CRM history')
