"""Gmail SMTP (app password) email digests for Tier Shipping Gap alerts. Full design
and constraints in docs/customer-segmentation-rules.md — short version:

- Each AE with a known email (a User row, role='ae', matching ae_code) gets an HTML
  detail table of just their own overdue accounts.
- Every admin User gets one HTML summary report (totals, by-AE, by-tier, and a short
  worst-offenders list) covering every overdue account, every AE -- deliberately not a
  full per-company dump, since the AE digests already carry that detail.
- AE codes with no known email (most of them today — see the doc) aren't emailed
  individually, but their breaches still reach someone via the admin summary.
- Every send is multipart (HTML + a plain-text fallback) for clients that block HTML.
- Sends via plain SMTP (smtplib, stdlib — no new dependency) rather than a third-party
  provider. Was originally built against Resend's API, but that needs a verified
  sending domain to reach real inboxes without landing in spam, and there's no DNS
  access here to set one up (2026-09-03 decision) — a Gmail account + app password
  sends from an address with real sender reputation already, no domain work needed.
- Gated by `settings.tier_alert_email_enabled` and SMTP username/password both being
  non-blank — all must be true or this is a silent no-op. That's the safety net that
  keeps this from firing in tests or in an environment nobody's deliberately turned it
  on for.
"""
import logging
import smtplib
from datetime import date, datetime, timedelta
from decimal import Decimal
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .core import settings
from .models import CrmSyncState, User
from .tier_alerts import get_tier_shipping_gap_breaches, get_tier_shipping_gap_due_warnings

log = logging.getLogger('email-notifications')


def _smtp_configured() -> bool:
    return bool(settings.smtp_username and settings.smtp_password.get_secret_value())


def _send_email(to: str, subject: str, text_body: str, html_body: str) -> bool:
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = settings.smtp_from_email or settings.smtp_username
    msg['To'] = to
    # Plain part first, HTML second -- clients that render both prefer the last part.
    msg.attach(MIMEText(text_body, 'plain'))
    msg.attach(MIMEText(html_body, 'html'))
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            server.starttls()
            server.login(settings.smtp_username, settings.smtp_password.get_secret_value())
            server.sendmail(msg['From'], [to], msg.as_string())
        return True
    except (smtplib.SMTPException, OSError) as exc:
        log.warning('smtp_send_failed to=%s error=%s', to, type(exc).__name__)
        return False


# Inline CSS only -- most email clients strip <style> blocks and external stylesheets,
# so every visual rule has to live on the element itself.
_TABLE_STYLE = 'border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:13px;'
_TH_STYLE = 'text-align:left;padding:8px 10px;background:#f1f5f9;color:#334155;border-bottom:2px solid #e2e8f0;'
_TD_STYLE = 'padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#1e293b;'
_WRAP_STYLE = 'font-family:Arial,Helvetica,sans-serif;color:#1e293b;'


def _html_wrap(inner: str) -> str:
    return f'<div style="{_WRAP_STYLE}">{inner}</div>'


def _format_ae_digest(breaches: list[dict], warnings: list[dict] | None = None) -> tuple[str, str]:
    """One AE's own overdue accounts -- a clean detail table (already scoped by the caller)."""
    warnings = warnings or []
    heading = f"{len(breaches)} of your accounts have gone quiet past their tier's shipping SLA:"

    text_lines = [heading, '']
    for b in breaches:
        text_lines.append(f"- {b['company_name']} ({b['customer_type']}): "
                           f"{b['days_overdue']} days overdue (SLA {b['sla_days']}d)")
    text_body = '\n'.join(text_lines) + _due_warnings_text(warnings)

    rows = ''.join(
        f'<tr>'
        f'<td style="{_TD_STYLE}">{escape(b["company_name"])}</td>'
        f'<td style="{_TD_STYLE}">{escape(b["customer_type"] or "")}</td>'
        f'<td style="{_TD_STYLE}font-weight:bold;color:#b91c1c;">{b["days_overdue"]}</td>'
        f'<td style="{_TD_STYLE}">{b["sla_days"]}</td>'
        f'</tr>'
        for b in breaches
    )
    breach_section = (
        f'<p>{escape(heading)}</p>'
        f'<table style="{_TABLE_STYLE}">'
        f'<thead><tr>'
        f'<th style="{_TH_STYLE}">Customer</th>'
        f'<th style="{_TH_STYLE}">Tier</th>'
        f'<th style="{_TH_STYLE}">Days Overdue</th>'
        f'<th style="{_TH_STYLE}">SLA (days)</th>'
        f'</tr></thead>'
        f'<tbody>{rows}</tbody>'
        f'</table>'
    ) if breaches else ''
    html_body = _html_wrap(_due_warnings_html(warnings) + breach_section)
    return text_body, html_body


_TH_AMBER = 'text-align:left;padding:8px 10px;background:#fef3c7;color:#92400e;border-bottom:2px solid #fde68a;'


def _due_warnings_html(warnings: list[dict]) -> str:
    """Amber 'Due Soon' table injected above the breach table."""
    if not warnings:
        return ''
    rows = ''.join(
        f'<tr>'
        f'<td style="{_TD_STYLE}">{escape(w["company_name"])}</td>'
        f'<td style="{_TD_STYLE}">{escape(w["customer_type"] or "")}</td>'
        f'<td style="{_TD_STYLE}font-weight:bold;color:#b45309;">{"Today" if w["days_until_breach"] == 0 else w["days_until_breach"]}</td>'
        f'<td style="{_TD_STYLE}">{w["sla_days"]}</td>'
        f'</tr>'
        for w in warnings
    )
    header = (f'<tr><th style="{_TH_AMBER}">Customer</th><th style="{_TH_AMBER}">Tier</th>'
              f'<th style="{_TH_AMBER}">Days Until Breach</th><th style="{_TH_AMBER}">SLA (days)</th></tr>')
    return (f'<h3 style="margin:18px 0 8px;font-size:14px;color:#92400e;">&#9888; Due Soon ({len(warnings)})</h3>'
            f'<table style="{_TABLE_STYLE}">'
            f'<thead>{header}</thead><tbody>{rows}</tbody></table>')


def _due_warnings_text(warnings: list[dict]) -> str:
    if not warnings:
        return ''
    lines = ['', '── DUE SOON ──']
    for w in warnings:
        days = 'today' if w['days_until_breach'] == 0 else f"in {w['days_until_breach']} day(s)"
        lines.append(f"  ! {w['company_name']} ({w['customer_type']}): breaches {days} (SLA {w['sla_days']}d)")
    return '\n'.join(lines)


_WORST_OFFENDERS_LIMIT = 5


def _format_admin_summary(breaches: list[dict], db: Session, warnings: list[dict] | None = None) -> tuple[str, str]:
    """Aggregate-only report for admins: totals, per-AE, per-tier, and a handful of
    worst-offender highlights -- deliberately not a full per-company dump."""
    warnings = warnings or []
    total = len(breaches)
    ae_with_email = _ae_codes_with_email(db)

    by_ae: dict[str, int] = {}
    for b in breaches:
        key = b['assigned_ae_code'] or 'Unassigned'
        by_ae[key] = by_ae.get(key, 0) + 1
    ae_rows_sorted = sorted(by_ae.items(), key=lambda kv: kv[1], reverse=True)

    by_tier: dict[str, dict] = {}
    for b in breaches:
        t = by_tier.setdefault(b['customer_type'], {'count': 0, 'sla_days': b['sla_days']})
        t['count'] += 1
    tier_rows_sorted = sorted(by_tier.items(), key=lambda kv: kv[1]['count'], reverse=True)

    worst = breaches[:_WORST_OFFENDERS_LIMIT]  # already sorted by days_since desc

    heading = f"{total} account(s) across all AEs have gone quiet past their tier's shipping SLA:"

    text_lines = [heading, '', 'By AE:']
    for ae, count in ae_rows_sorted:
        flag = '' if ae == 'Unassigned' or ae in ae_with_email else ' (no individual email on file)'
        text_lines.append(f"  {ae}: {count}{flag}")
    text_lines += ['', 'By Tier:']
    for tier, info in tier_rows_sorted:
        text_lines.append(f"  {tier}: {info['count']} (SLA {info['sla_days']}d)")
    text_lines += ['', f'Worst offenders (top {len(worst)}):']
    for b in worst:
        text_lines.append(f"  - {b['company_name']} ({b['customer_type']}, AE {b['assigned_ae_code'] or 'Unassigned'}): "
                           f"{b['days_overdue']} days overdue")
    text_body = '\n'.join(text_lines) + _due_warnings_text(warnings)

    def _small_table(header_cells: list[str], row_html: str) -> str:
        ths = ''.join(f'<th style="{_TH_STYLE}">{h}</th>' for h in header_cells)
        return f'<table style="{_TABLE_STYLE}margin-bottom:16px;"><thead><tr>{ths}</tr></thead><tbody>{row_html}</tbody></table>'

    ae_rows_html = ''.join(
        f'<tr><td style="{_TD_STYLE}">{escape(ae)}</td>'
        f'<td style="{_TD_STYLE}">{count}</td>'
        f'<td style="{_TD_STYLE}color:#64748b;font-size:12px;">'
        f'{"" if ae == "Unassigned" or ae in ae_with_email else "No individual email on file"}</td></tr>'
        for ae, count in ae_rows_sorted
    )
    tier_rows_html = ''.join(
        f'<tr><td style="{_TD_STYLE}">{escape(tier or "")}</td>'
        f'<td style="{_TD_STYLE}">{info["count"]}</td>'
        f'<td style="{_TD_STYLE}">{info["sla_days"]}</td></tr>'
        for tier, info in tier_rows_sorted
    )
    worst_rows_html = ''.join(
        f'<tr><td style="{_TD_STYLE}">{escape(b["company_name"])}</td>'
        f'<td style="{_TD_STYLE}">{escape(b["customer_type"] or "")}</td>'
        f'<td style="{_TD_STYLE}">{escape(b["assigned_ae_code"] or "Unassigned")}</td>'
        f'<td style="{_TD_STYLE}font-weight:bold;color:#b91c1c;">{b["days_overdue"]}</td></tr>'
        for b in worst
    )

    html_body = _html_wrap(
        _due_warnings_html(warnings)
        + f'<p><strong>{total}</strong> account(s) across all AEs have gone quiet past their tier\'s shipping SLA.</p>'
        + f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">By AE</h3>'
        + _small_table(['AE', 'Overdue Accounts', 'Notes'], ae_rows_html)
        + '<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">By Tier</h3>'
        + _small_table(['Tier', 'Overdue Accounts', 'SLA (days)'], tier_rows_html)
        + f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">Worst Offenders (top {len(worst)})</h3>'
        + _small_table(['Customer', 'Tier', 'AE', 'Days Overdue'], worst_rows_html)
    )
    return text_body, html_body


def send_tier_alert_digests(db: Session) -> dict:
    """Returns a summary dict of what was (or would have been) sent, for the admin
    endpoint's response and for tests. Always computes breaches even when sending is
    disabled, so the caller can see what's pending without needing SMTP configured."""
    breaches = get_tier_shipping_gap_breaches(db)
    warnings = get_tier_shipping_gap_due_warnings(db)
    result = {'enabled': settings.tier_alert_email_enabled and _smtp_configured(),
               'total_breaches': len(breaches), 'total_warnings': len(warnings),
               'ae_emails_sent': 0, 'admin_emails_sent': 0,
               'ae_codes_without_email': sorted({b['assigned_ae_code'] for b in breaches
                                                  if b['assigned_ae_code']} - _ae_codes_with_email(db))}
    if not result['enabled'] or (not breaches and not warnings):
        return result

    by_ae_breaches: dict[str, list[dict]] = {}
    for b in breaches:
        if b['assigned_ae_code']:
            by_ae_breaches.setdefault(b['assigned_ae_code'], []).append(b)

    by_ae_warnings: dict[str, list[dict]] = {}
    for w in warnings:
        if w['assigned_ae_code']:
            by_ae_warnings.setdefault(w['assigned_ae_code'], []).append(w)

    all_ae_codes = set(by_ae_breaches) | set(by_ae_warnings)
    ae_users = db.scalars(select(User).where(User.role == 'ae', User.is_active == True, User.ae_code.isnot(None), User.email_alerts_enabled == True)).all()  # noqa: E712
    for u in ae_users:
        their_breaches = by_ae_breaches.get(u.ae_code, [])
        their_warnings = by_ae_warnings.get(u.ae_code, [])
        if not their_breaches and not their_warnings:
            continue
        text_body, html_body = _format_ae_digest(their_breaches, their_warnings)
        subject = f"Customer 360: {len(their_breaches)} overdue" + (f", {len(their_warnings)} due soon" if their_warnings else "")
        if _send_email(u.email, subject, text_body, html_body):
            result['ae_emails_sent'] += 1

    admin_users = db.scalars(select(User).where(User.role.in_(['admin', 'super_admin']), User.is_active == True, User.email_alerts_enabled == True)).all()
    if admin_users:
        admin_text, admin_html = _format_admin_summary(breaches, db, warnings)
        ae_count = len({b['assigned_ae_code'] for b in breaches if b['assigned_ae_code']})
        admin_subject = f"Customer 360: Daily digest — {len(breaches)} overdue, {len(warnings)} due soon"
        for u in admin_users:
            if _send_email(u.email, admin_subject, admin_text, admin_html):
                result['admin_emails_sent'] += 1

    return result


def _ae_codes_with_email(db: Session) -> set[str]:
    return {u.ae_code for u in db.scalars(
        select(User).where(User.role == 'ae', User.is_active == True, User.ae_code.isnot(None), User.email_alerts_enabled == True)  # noqa: E712
    ).all()}


# ── Immediate breach alert (Key Account / Reseller, 7-day SLA) ────────────────────
# Separate from the daily digest above: an urgent, single-company email fired as soon
# as a Key Account or Reseller first crosses its SLA, rather than waiting for the next
# morning's digest. Uses CrmSyncState to remember which companies were already emailed
# so the same breach doesn't re-fire every time the worker's check runs (every few
# hours); the notified set is replaced (not unioned) with the current breach list each
# run, so a company that ships again and later goes quiet a second time re-triggers.
_IMMEDIATE_NOTIFIED_ENTITY = 'tier_breach_immediate_notified'


def _format_immediate_breach_group(breaches: list[dict]) -> tuple[str, str]:
    """One email summarising all new SLA breaches for a recipient."""
    n = len(breaches)
    text_lines = [f"URGENT: {n} new SLA breach{'es' if n != 1 else ''}\n"]
    for b in breaches:
        text_lines.append(
            f"- {b['company_name']} ({b['customer_type']}) — {b['days_overdue']} day(s) overdue, "
            f"{b['days_since']} days since last shipment, AE: {b['assigned_ae_code'] or 'Unassigned'}"
        )
    text_body = '\n'.join(text_lines)

    _TH = 'padding:8px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;'
    _TD = 'padding:8px 12px;font-size:12px;border-bottom:1px solid #f3f4f6;'
    header = (
        f'<tr>'
        f'<th style="{_TH}">Customer</th>'
        f'<th style="{_TH}">Tier</th>'
        f'<th style="{_TH}">AE</th>'
        f'<th style="{_TH}">Days Overdue</th>'
        f'<th style="{_TH}">Days Since Shipment</th>'
        f'<th style="{_TH}">SLA</th>'
        f'</tr>'
    )
    rows = ''.join(
        f'<tr>'
        f'<td style="{_TD}font-weight:bold;">{escape(b["company_name"])}</td>'
        f'<td style="{_TD}">{escape(b["customer_type"])}</td>'
        f'<td style="{_TD}">{escape(b["assigned_ae_code"] or "Unassigned")}</td>'
        f'<td style="{_TD}font-weight:bold;color:#b91c1c;">{b["days_overdue"]}</td>'
        f'<td style="{_TD}">{b["days_since"]}</td>'
        f'<td style="{_TD}">{b["sla_days"]} days</td>'
        f'</tr>'
        for b in breaches
    )
    html_body = _html_wrap(
        f'<p><strong>{n} new SLA breach{"es" if n != 1 else ""}</strong> requiring immediate attention:</p>'
        f'<table style="{_TABLE_STYLE}"><thead>{header}</thead><tbody>{rows}</tbody></table>'
    )
    return text_body, html_body


def send_immediate_tier_breach_emails(db: Session) -> dict:
    """Fires one grouped urgent email per recipient when new Key Account/Reseller SLA
    breaches are detected — called every couple of hours by the worker. Grouped so that
    N new breaches generate at most 1 email per recipient, not N emails."""
    breaches = get_tier_shipping_gap_breaches(db)
    result = {'enabled': settings.tier_alert_email_enabled and _smtp_configured(),
               'new_breaches': 0, 'ae_emails_sent': 0, 'admin_emails_sent': 0}

    state = db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type == _IMMEDIATE_NOTIFIED_ENTITY))
    # notified_map: {company_id: iso_timestamp} — append-only with 7-day TTL expiry
    raw_map: dict = (state.cursor_json or {}) if state else {}
    cutoff = (datetime.utcnow() - timedelta(days=7)).isoformat()
    already_notified = {cid for cid, ts in raw_map.items() if ts >= cutoff}

    if not result['enabled']:
        return result

    new_breaches = [b for b in breaches if b['company_id'] not in already_notified]
    result['new_breaches'] = len(new_breaches)

    if new_breaches:
        n = len(new_breaches)
        subject = (
            f"Urgent: {new_breaches[0]['company_name']} ({new_breaches[0]['customer_type']}) — {new_breaches[0]['days_overdue']} days overdue"
            if n == 1 else
            f"Urgent: {n} new SLA breaches"
        )

        # Group by AE — each AE gets one email with only their accounts
        by_ae: dict[str, list[dict]] = {}
        for b in new_breaches:
            if b['assigned_ae_code']:
                by_ae.setdefault(b['assigned_ae_code'], []).append(b)

        ae_users_by_code = {u.ae_code: u for u in db.scalars(
            select(User).where(User.role == 'ae', User.is_active == True, User.ae_code.isnot(None), User.email_alerts_enabled == True)  # noqa: E712
        ).all()}
        for ae_code, ae_breaches in by_ae.items():
            ae_user = ae_users_by_code.get(ae_code)
            if not ae_user:
                continue
            text_body, html_body = _format_immediate_breach_group(ae_breaches)
            ae_subject = subject if n == 1 else f"Urgent: {len(ae_breaches)} new SLA breach{'es' if len(ae_breaches) != 1 else ''} in your accounts"
            if _send_email(ae_user.email, ae_subject, text_body, html_body):
                result['ae_emails_sent'] += 1

        # Admins get one email with all new breaches
        admin_users = db.scalars(select(User).where(User.role.in_(['admin', 'super_admin']), User.is_active == True, User.email_alerts_enabled == True)).all()  # noqa: E712
        if admin_users:
            text_body, html_body = _format_immediate_breach_group(new_breaches)
            for u in admin_users:
                if _send_email(u.email, subject, text_body, html_body):
                    result['admin_emails_sent'] += 1

    if not state:
        state = CrmSyncState(entity_type=_IMMEDIATE_NOTIFIED_ENTITY, cursor_json={})
        db.add(state)
    now_iso = datetime.utcnow().isoformat()
    # Merge new breach IDs in; expire entries older than 7 days; never replace the whole set.
    merged = {cid: ts for cid, ts in raw_map.items() if ts >= cutoff}
    for b in new_breaches:
        merged[b['company_id']] = now_iso
    state.cursor_json = merged
    db.commit()

    return result


# ── Weekly report ─────────────────────────────────────────────────────────────

_REVENUE_SQL = ("CASE WHEN upper(trim(coalesce(s.pay_term,''))) IN ('PP','FC','FD') "
                "THEN coalesce(s.bill_amount, s.declared_value, 0) ELSE 0 END")


def _weekly_kpis(db: Session, week_start: date, week_end: date) -> dict:
    row = db.execute(text(
        f"SELECT count(*) AS shipments, "
        f"sum({_REVENUE_SQL}) AS revenue, "
        f"count(DISTINCT s.company_id) FILTER (WHERE s.company_id IS NOT NULL) AS active_customers "
        f"FROM shipments s "
        f"JOIN master_air_waybills m ON s.mawb_id = m.id "
        f"WHERE m.manifest_date BETWEEN :start AND :end"
    ), {'start': week_start, 'end': week_end}).mappings().one()
    revenue = Decimal(str(row['revenue'] or 0))
    active = row['active_customers'] or 0
    return {
        'shipments': row['shipments'] or 0,
        'revenue': revenue,
        'arpu': (revenue / active).quantize(Decimal('0.01')) if active else Decimal('0'),
        'active_customers': active,
    }


def _weekly_ae_performance(db: Session, week_start: date, week_end: date) -> list[dict]:
    rows = db.execute(text(
        f"SELECT coalesce(s.ae_code,'Unassigned') AS ae_code, "
        f"count(*) AS shipments, "
        f"sum({_REVENUE_SQL}) AS revenue, "
        f"count(DISTINCT s.company_id) FILTER (WHERE s.company_id IS NOT NULL) AS customers "
        f"FROM shipments s "
        f"JOIN master_air_waybills m ON s.mawb_id = m.id "
        f"WHERE m.manifest_date BETWEEN :start AND :end "
        f"GROUP BY coalesce(s.ae_code,'Unassigned') "
        f"ORDER BY sum({_REVENUE_SQL}) DESC"
    ), {'start': week_start, 'end': week_end}).mappings().all()
    return [dict(r) for r in rows]


def _weekly_top_customers(db: Session, week_start: date, week_end: date, limit: int = 10) -> list[dict]:
    rows = db.execute(text(
        f"SELECT coalesce(c.company_name, 'Unknown') AS company_name, "
        f"count(*) AS shipments, "
        f"sum({_REVENUE_SQL}) AS revenue "
        f"FROM shipments s "
        f"LEFT JOIN companies c ON s.company_id = c.id "
        f"JOIN master_air_waybills m ON s.mawb_id = m.id "
        f"WHERE m.manifest_date BETWEEN :start AND :end "
        f"GROUP BY c.company_name "
        f"ORDER BY sum({_REVENUE_SQL}) DESC "
        f"LIMIT :limit"
    ), {'start': week_start, 'end': week_end, 'limit': limit}).mappings().all()
    return [dict(r) for r in rows]


def _weekly_new_customers(db: Session, week_start: date, week_end: date) -> list[str]:
    rows = db.execute(text(
        "SELECT c.company_name FROM companies c "
        "WHERE c.id IN ("
        "  SELECT s.company_id FROM shipments s "
        "  JOIN master_air_waybills m ON s.mawb_id = m.id "
        "  WHERE s.company_id IS NOT NULL "
        "  GROUP BY s.company_id "
        "  HAVING min(m.manifest_date) BETWEEN :start AND :end"
        ") ORDER BY c.company_name"
    ), {'start': week_start, 'end': week_end}).scalars().all()
    return list(rows)


def _weekly_open_issues(db: Session) -> int:
    return db.execute(text(
        "SELECT count(*) FROM data_quality_issues WHERE status IN ('open','reviewed','acknowledged')"
    )).scalar() or 0


def _fmt_currency(v) -> str:
    return f"${Decimal(str(v or 0)):,.2f}"


def _format_weekly_admin(kpis: dict, ae_perf: list[dict], top_customers: list[dict],
                          new_customers: list[str], open_issues: int,
                          week_start: date, week_end: date) -> tuple[str, str]:
    period = f"{week_start} to {week_end}"

    text_lines = [
        f"Customer 360 — Weekly Report ({period})", "",
        "── OPERATIONAL KPIs ──",
        f"  Shipments    : {kpis['shipments']}",
        f"  Revenue      : {_fmt_currency(kpis['revenue'])}",
        f"  ARPU         : {_fmt_currency(kpis['arpu'])}",
        f"  Active Customers: {kpis['active_customers']}",
        f"  Open Quality Issues: {open_issues}", "",
        "── AE PERFORMANCE ──",
    ]
    for r in ae_perf:
        text_lines.append(f"  {r['ae_code']}: {r['shipments']} shipments, {_fmt_currency(r['revenue'])}, {r['customers']} customers")
    text_lines += ["", "── TOP 10 CUSTOMERS BY REVENUE ──"]
    for i, r in enumerate(top_customers, 1):
        text_lines.append(f"  {i}. {r['company_name']}: {_fmt_currency(r['revenue'])} ({r['shipments']} shipments)")
    if new_customers:
        text_lines += ["", f"── NEW CUSTOMERS THIS WEEK ({len(new_customers)}) ──"]
        for name in new_customers:
            text_lines.append(f"  + {name}")
    text_body = '\n'.join(text_lines)

    def _tbl(headers, rows_html):
        ths = ''.join(f'<th style="{_TH_STYLE}">{h}</th>' for h in headers)
        return f'<table style="{_TABLE_STYLE}margin-bottom:16px;"><thead><tr>{ths}</tr></thead><tbody>{rows_html}</tbody></table>'

    kpi_rows = ''.join(
        f'<tr><td style="{_TD_STYLE}">{k}</td><td style="{_TD_STYLE}font-weight:bold;">{v}</td></tr>'
        for k, v in [
            ('Shipments', kpis['shipments']),
            ('Revenue', _fmt_currency(kpis['revenue'])),
            ('ARPU', _fmt_currency(kpis['arpu'])),
            ('Active Customers', kpis['active_customers']),
            ('Open Quality Issues', open_issues),
        ]
    )
    ae_rows = ''.join(
        f'<tr><td style="{_TD_STYLE}">{escape(r["ae_code"])}</td>'
        f'<td style="{_TD_STYLE}">{r["shipments"]}</td>'
        f'<td style="{_TD_STYLE}">{_fmt_currency(r["revenue"])}</td>'
        f'<td style="{_TD_STYLE}">{r["customers"]}</td></tr>'
        for r in ae_perf
    )
    cust_rows = ''.join(
        f'<tr><td style="{_TD_STYLE}">{escape(r["company_name"])}</td>'
        f'<td style="{_TD_STYLE}">{r["shipments"]}</td>'
        f'<td style="{_TD_STYLE}">{_fmt_currency(r["revenue"])}</td></tr>'
        for r in top_customers
    )
    new_html = (
        f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">New Customers This Week ({len(new_customers)})</h3>'
        + ''.join(f'<div style="padding:4px 0;color:#15803d;">+ {escape(n)}</div>' for n in new_customers)
    ) if new_customers else ''

    html_body = _html_wrap(
        f'<h2 style="font-size:16px;color:#0f172a;">Customer 360 Weekly Report</h2>'
        f'<p style="color:#64748b;font-size:12px;">{period}</p>'
        f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">Operational KPIs</h3>'
        + _tbl(['Metric', 'Value'], kpi_rows)
        + f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">AE Performance</h3>'
        + _tbl(['AE', 'Shipments', 'Revenue', 'Customers'], ae_rows)
        + f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">Top 10 Customers by Revenue</h3>'
        + _tbl(['Customer', 'Shipments', 'Revenue'], cust_rows)
        + new_html
    )
    return text_body, html_body


def _format_weekly_ae(ae_code: str, ae_row: dict | None, top_customers: list[dict],
                       week_start: date, week_end: date) -> tuple[str, str]:
    period = f"{week_start} to {week_end}"
    shipments = ae_row['shipments'] if ae_row else 0
    revenue = ae_row['revenue'] if ae_row else Decimal('0')
    customers = ae_row['customers'] if ae_row else 0

    text_lines = [
        f"Customer 360 — Your Weekly Report ({period})", "",
        f"AE: {ae_code}",
        f"  Shipments    : {shipments}",
        f"  Revenue      : {_fmt_currency(revenue)}",
        f"  Active Customers: {customers}", "",
        "── YOUR TOP CUSTOMERS BY REVENUE ──",
    ]
    for i, r in enumerate(top_customers, 1):
        text_lines.append(f"  {i}. {r['company_name']}: {_fmt_currency(r['revenue'])} ({r['shipments']} shipments)")
    text_body = '\n'.join(text_lines)

    def _tbl(headers, rows_html):
        ths = ''.join(f'<th style="{_TH_STYLE}">{h}</th>' for h in headers)
        return f'<table style="{_TABLE_STYLE}margin-bottom:16px;"><thead><tr>{ths}</tr></thead><tbody>{rows_html}</tbody></table>'

    cust_rows = ''.join(
        f'<tr><td style="{_TD_STYLE}">{escape(r["company_name"])}</td>'
        f'<td style="{_TD_STYLE}">{r["shipments"]}</td>'
        f'<td style="{_TD_STYLE}">{_fmt_currency(r["revenue"])}</td></tr>'
        for r in top_customers
    )
    html_body = _html_wrap(
        f'<h2 style="font-size:16px;color:#0f172a;">Your Weekly Report — {escape(ae_code)}</h2>'
        f'<p style="color:#64748b;font-size:12px;">{period}</p>'
        f'<p><strong>Shipments:</strong> {shipments} &nbsp;|&nbsp; '
        f'<strong>Revenue:</strong> {_fmt_currency(revenue)} &nbsp;|&nbsp; '
        f'<strong>Active Customers:</strong> {customers}</p>'
        f'<h3 style="margin:18px 0 8px;font-size:14px;color:#334155;">Your Top Customers by Revenue</h3>'
        + _tbl(['Customer', 'Shipments', 'Revenue'], cust_rows)
    )
    return text_body, html_body


def send_weekly_report(db: Session) -> dict:
    """Comprehensive weekly report: AE performance, top customers, operational KPIs.
    Admins get the full report; each AE gets their own slice.
    Follows the same guard pattern as send_tier_alert_digests — silent no-op unless
    weekly_report_email_enabled and SMTP both configured."""
    enabled = settings.weekly_report_email_enabled and _smtp_configured()
    result = {'enabled': enabled, 'ae_emails_sent': 0, 'admin_emails_sent': 0}
    if not enabled:
        return result

    week_end = date.today() - timedelta(days=1)   # yesterday
    week_start = week_end - timedelta(days=6)      # 7-day window ending yesterday

    kpis = _weekly_kpis(db, week_start, week_end)
    ae_perf = _weekly_ae_performance(db, week_start, week_end)
    top_customers = _weekly_top_customers(db, week_start, week_end)
    new_customers = _weekly_new_customers(db, week_start, week_end)
    open_issues = _weekly_open_issues(db)

    ae_perf_by_code = {r['ae_code']: r for r in ae_perf}
    period_label = f"{week_start} to {week_end}"

    # Admin/super_admin: full report
    admin_users = db.scalars(select(User).where(
        User.role.in_(['admin', 'super_admin']), User.is_active == True, User.email_alerts_enabled == True  # noqa: E712
    )).all()
    if admin_users:
        admin_text, admin_html = _format_weekly_admin(
            kpis, ae_perf, top_customers, new_customers, open_issues, week_start, week_end
        )
        subject = f"Customer 360: Weekly Report ({period_label})"
        for u in admin_users:
            if _send_email(u.email, subject, admin_text, admin_html):
                result['admin_emails_sent'] += 1

    # AE users: their own slice
    ae_users = db.scalars(select(User).where(
        User.role == 'ae', User.is_active == True, User.ae_code.isnot(None), User.email_alerts_enabled == True  # noqa: E712
    )).all()
    for u in ae_users:
        ae_top = _weekly_top_customers_for_ae(db, u.ae_code, week_start, week_end)
        ae_text, ae_html = _format_weekly_ae(
            u.ae_code, ae_perf_by_code.get(u.ae_code), ae_top, week_start, week_end
        )
        subject = f"Customer 360: Your Weekly Report ({period_label})"
        if _send_email(u.email, subject, ae_text, ae_html):
            result['ae_emails_sent'] += 1

    return result


def _weekly_top_customers_for_ae(db: Session, ae_code: str, week_start: date, week_end: date, limit: int = 10) -> list[dict]:
    rows = db.execute(text(
        f"SELECT coalesce(c.company_name,'Unknown') AS company_name, "
        f"count(*) AS shipments, "
        f"sum({_REVENUE_SQL}) AS revenue "
        f"FROM shipments s "
        f"LEFT JOIN companies c ON s.company_id = c.id "
        f"JOIN master_air_waybills m ON s.mawb_id = m.id "
        f"WHERE m.manifest_date BETWEEN :start AND :end AND s.ae_code = :ae "
        f"GROUP BY c.company_name "
        f"ORDER BY sum({_REVENUE_SQL}) DESC "
        f"LIMIT :limit"
    ), {'start': week_start, 'end': week_end, 'ae': ae_code, 'limit': limit}).mappings().all()
    return [dict(r) for r in rows]
