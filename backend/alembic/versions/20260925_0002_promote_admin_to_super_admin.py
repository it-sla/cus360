"""promote existing 'admin' users to 'super_admin'

The RBAC redesign makes 'admin' a read-only role (see auth.access_guard) and moves all
the CRUD/Administration power that used to belong to 'admin' onto 'super_admin' instead
(see ROLE.md). Every account holding today's full-power 'admin' role is promoted so
nobody silently loses access they use daily; an operator demotes individual accounts to
plain 'admin' by hand afterwards via the Users page, where it's a one-click, reviewable
decision instead of a blind bulk migration guess.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "20260925_0002"
down_revision: Union[str, None] = "20260925_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE users SET role = 'super_admin' WHERE role = 'admin'")


def downgrade() -> None:
    # No-op: there's no reliable way to tell "was admin before this migration" apart from
    # "became super_admin some other way afterwards" — reverting would risk demoting an
    # account that was intentionally promoted after this ran. Demote by hand via the
    # Users page if this migration needs to be undone for a specific account.
    pass
