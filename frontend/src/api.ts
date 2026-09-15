import axios from 'axios';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

export type AuthRole = 'super_admin' | 'admin' | 'sales_lead' | 'ae' | 'user';
const KNOWN_ROLES: AuthRole[] = ['super_admin', 'admin', 'sales_lead', 'ae', 'user'];

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  role: AuthRole;
  ae_code: string | null;
  must_change_password: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

function normalizeAuthUser(raw: any): AuthUser {
  const user = raw?.user ?? raw;
  const rawRole = user?.role;

  return {
    id: String(user?.id ?? user?.user_id ?? user?.email ?? 'unknown'),
    email: String(user?.email ?? ''),
    display_name: String(user?.display_name ?? user?.name ?? user?.email ?? 'User'),
    role: KNOWN_ROLES.includes(rawRole) ? rawRole : 'user',
    ae_code: user?.ae_code ?? null,
    must_change_password: Boolean(user?.must_change_password),
  };
}

export const authApi = {
  login: async (credentials: LoginCredentials): Promise<AuthUser> => {
    const response = await apiClient.post('/auth/login', credentials);
    return normalizeAuthUser(response.data);
  },

  me: async (): Promise<AuthUser> => {
    const response = await apiClient.get('/auth/me');
    return normalizeAuthUser(response.data);
  },

  logout: async (): Promise<void> => {
    await apiClient.post('/auth/logout');
  },

  setPassword: async (token: string, password: string): Promise<AuthUser> => {
    const response = await apiClient.post('/auth/set-password', { token, password });
    return normalizeAuthUser(response.data);
  },
};

export interface KpiCardData {
  value: number;
  pop_pct: number;
}

export interface DashboardData {
  kpi_cards: {
    total_billing: KpiCardData;
    shipment_count: KpiCardData;
    active_customers: KpiCardData;
  };
  leaderboards: {
    top_growth: Array<{ company_name: string; diff: number; current_revenue: number }>;
    top_declining: Array<{ company_name: string; diff: number; current_revenue: number }>;
    dormant: Array<{ company_name: string; days_inactive: number; previous_revenue: number }>;
  };
}

export interface SearchResultItem {
  result_type: 'company' | 'shipment' | 'package' | 'document' | 'mawb';
  id: string;
  title: string;
  subtitle: string;
  url: string;
  rank: number;
  metadata?: Record<string, any>;
}

export interface CustomerAnalyticsRow {
  company_id: string;
  company_name: string;
  icris_number: string | null;
  revenue: number;
  shipments: number;
  currency: string;
  ae_code: string;
  weight: number;
  pieces: number;
  country: string;
  last_shipment_date: string;
  segment: string;
}

export interface DashboardResponse {
  timeframe: string;
  bounds: { c_start: string; c_end: string; p_start: string; p_end: string };
  sp_manifest_report: {
    total_weight: number;
    total_pieces: number;
    total_bill_amount: number;
    total_shipment_count: number;
  };
  ae_performance: any[];
  kpi_cards: {
    active_customers: { value: number; pop_pct: number };
    new_customers: { value: number; pop_pct: number };
    returning_customers: { value: number; pop_pct: number };
    reactivated_customers: { value: number; pop_pct: number };
    total_billing: { value: number; pop_pct: number };
    total_invoices: { value: number; pop_pct: number };
    avg_revenue_per_customer: { value: number; pop_pct: number };
    avg_invoice_value: { value: number; pop_pct: number };
    highest_spending_customer: any;
    retention_rate: { value: number; pop_pct: number };
    growth_rate: { value: number };
  };
  revenue_analytics: {
    top_customers: any[];
    all_customers: CustomerAnalyticsRow[];
    pareto_80_20: any[];
    growth_matrix: any[];
  };
  customer_growth: {
    fastest_growing: any[];
    declining_customers: any[];
    dormant_customers: any[];
    new_count: number;
    returning_count: number;
  };
  billing_analytics: {
    trend: any[];
    prev_trend: any[];
    largest_bills: any[];
    bill_types: any[];
  };
  customer_behavior: {
    revenue_tiers: any[];
    country_segmentation: any[];
    countries_served_count: number;
    repeat_purchase_rate: number;
  };
  operational_analytics: {
    total_packages: number;
    avg_packages_per_shipment: number;
    revenue_per_shipment: number;
    revenue_per_package: number;
  };
  leaderboards: {
    top_revenue: any[];
    top_growth: any[];
    top_shipments: any[];
    top_declining: any[];
    top_ae: any[];
  };
  executive_insights: {
    revenue_comparison: { current: number; previous: number; pop_pct: number; diff: number };
    customer_comparison: { current: number; previous: number; pop_pct: number; diff: number };
    top10_concentration_pct: number;
    top_revenue_driver: any;
    biggest_decline: any;
    summary_narrative: string;
  };
}

export interface SearchResponse {
  query: string;
  items: SearchResultItem[];
}

// ── AE Performance ──────────────────────────────────────────────────

export interface AECustomer {
  company_id: string | null;
  company_name: string;
  icris_number: string | null;
  segment: string;
  revenue: number;
  shipments: number;
  weight: number;
  pieces: number;
  last_shipment_date: string | null;
  days_since_last_shipment: number | null;
  status: 'Active' | 'Warning' | 'Dormant' | 'Unknown';
  is_new: boolean;
  is_reactivated: boolean;
}

export interface AEPerformanceItem {
  ae: string;
  revenue: number;
  prev_revenue: number;
  revenue_growth_pct: number;
  revenue_share_pct: number;
  shipments: number;
  prev_shipments: number;
  shipment_growth_pct: number;
  weight: number;
  pieces: number;
  companies: number;
  prev_companies: number;
  retained_companies: number;
  active: number;
  warning: number;
  dormant: number;
  unknown: number;
  reactivated: number;
  new_customers: number;
  avg_revenue_per_customer: number;
  avg_revenue_per_shipment: number;
  segments: Record<string, number>;
  customers: AECustomer[];
}

export interface AEPerformanceResponse {
  timeframe: string;
  bounds: { c_start: string; c_end: string; p_start: string; p_end: string };
  health_thresholds: { active_days: number; warning_days: number; reactivation_gap_months: number };
  segments: string[];
  items: AEPerformanceItem[];
}

export interface LeaderboardEntry {
  ae_code: string;
  display_name: string;
  revenue: number;
  shipments: number;
  weight: number;
  wins: number;
  rank: number;
  ranks: { revenue: number; shipments: number; weight: number; wins: number };
}

export interface LeaderboardResponse {
  period: { start: string; end: string; label: string };
  leaderboards: { revenue: LeaderboardEntry[]; shipments: LeaderboardEntry[]; weight: LeaderboardEntry[]; wins: LeaderboardEntry[] };
}

export interface LeaderboardParams {
  timeframe?: string;
  date_from?: string;
  date_to?: string;
}

// ── Company types ───────────────────────────────────────────────────

export interface CompanySummary {
  company_id: string;
  icris_number: string | null;
  company_name: string;
  company_status: string;
  is_provisional: boolean;
  crm_last_synced_at: string | null;
  shipment_count: number;
  package_count: number;
  matched_shipment_count: number;
  suggested_shipment_count: number;
  unmatched_shipment_count: number;
  last_shipment_date: string | null;
  last_imported_at: string | null;
  document_count: number;
  active_document_count: number;
  name_mismatch_count: number;
  days_since_last_shipment: number | null;
  inactivity_status: 'active' | 'quiet' | 'inactive' | 'dormant';
  ae_code?: string | null;
  country?: string | null;
  revenue?: number;
  total_weight?: number;
  repeat_rate?: number;
  customer_type?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface CompanyListResponse {
  items: CompanySummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CompanyDetail {
  id: string;
  icris_number: string | null;
  company_name: string;
  normalized_name: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  pan_vat_number: string | null;
  customer_type: string | null;
  status: string;
  notes: string | null;
  source: string;
  is_provisional: boolean;
  crm_customer_id: string | null;
  crm_last_synced_at: string | null;
  name_source: string | null;
  manual_override_fields: string[];
  last_company_import_at: string | null;
  last_company_import_batch_id: string | null;
  created_at: string;
  updated_at: string;
  summary: CompanySummary;
  days_since_last_shipment: number | null;
  inactivity_status: string;
  aliases: CompanyAlias[];
  ae_code: string | null;
  assigned_ae_code: string | null;
  country: string | null;
  revenue: number;
  repeat_rate: number;
  shipment_count: number;
}

export interface CompanyAlias {
  id: string;
  company_id: string;
  alias_name: string;
  normalized_alias_name: string;
  source: string;
  created_at: string;
}

export interface CompanyShipment {
  id: string;
  shipment_number: string;
  shipment_date: string | null;
  pieces: number | null;
  shipment_weight: number | null;
  weight_unit: string | null;
  bill_type: string | null;
  import_country: string | null;
  export_country: string | null;
  shipper_name: string | null;
  importer_name: string | null;
  goods_description: string | null;
  source: string;
  match_status: string;
  created_at: string;
  package_count: number;
}

export interface CompanyDocument {
  id: string;
  company_id: string;
  title: string;
  original_file_name: string;
  stored_file_name: string;
  mime_type: string;
  file_extension: string | null;
  file_size_bytes: number;
  category: string;
  description: string | null;
  tags: string[];
  document_date: string | null;
  version_number: number;
  status: string;
  uploaded_at: string;
}

export interface CompanyStorageStats {
  total_documents: number;
  total_size_bytes: number;
  by_category: Record<string, { count: number; bytes: number }>;
  by_extension: Record<string, { count: number; bytes: number }>;
}

export interface CompanyAnalyticsKpi {
  value: number;
  pop_pct: number | null;
}

export interface CompanyAnalytics {
  bounds: { c_start: string; c_end: string; p_start: string; p_end: string };
  kpi_cards: {
    revenue: CompanyAnalyticsKpi;
    shipments: CompanyAnalyticsKpi;
    weight: CompanyAnalyticsKpi;
    avg_shipment_value: CompanyAnalyticsKpi;
  };
  trend: { month: string; revenue: number; shipments: number; weight: number }[];
  weights: { weight_unit: string; total: number }[];
  destinations: { import_country: string; count: number }[];
  destination_options: { import_country: string; count: number }[];
}

export interface ActivityLog {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  description: string;
  source: string;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
}

export interface Shipment {
  id: string;
  shipment_number: string;
  company_id: string | null;
  mawb_id: string | null;
  shipment_date: string | null;
  pieces: number | null;
  shipment_weight: number | null;
  actual_weight: number | null;
  weight_unit: string | null;
  bill_type: string | null;
  pay_term: string | null;
  bill_amount: number | null;
  declared_value: number | null;
  revenue: number;
  import_country: string | null;
  export_country: string | null;
  shipper_name: string | null;
  importer_name: string | null;
  importer_telephone: string | null;
  goods_description: string | null;
  source: string;
  match_status: string;
  ae_code: string | null;
  created_at: string;
  company?: { id: string; company_name: string; icris_number: string | null; [key: string]: any } | null;
  package_count?: number;
  [key: string]: any;
}

export interface MawbSummary {
  id: string;
  mawb_number: string;
  manifest_date: string;
  flight_number: string | null;
  origin: string | null;
  destination: string | null;
  pp_weight: number | null;
  fc_weight: number | null;
  fd_weight: number | null;
  pp_pieces: number | null;
  fc_pieces: number | null;
  fd_pieces: number | null;
  shipment_count?: number;
  row_pieces?: number;
  row_actual_weight?: number;
  last_synced_at: string;
  manifest_direction?: string | null;
  crm_manifest_id?: string | null;
  customer_count?: number;
  missing_icris_count?: number;
  pnl_bill_amount: number | null;
  pnl_ups_bill_amount: number | null;
  pnl_profit_loss: number | null;
  pnl_synced_at: string | null;
}

export interface PnlMawbRef {
  id: string;
  mawb_number: string;
  manifest_date: string;
  bill_amount: number;
  ups_bill_amount: number;
  profit_loss: number;
  margin_percent: number;
}

export interface PnlTrendPoint {
  period: string;
  mawb_count: number;
  bill_amount: number;
  ups_bill_amount: number;
  profit_loss: number;
}

export interface CustomerProfitability {
  company_id: string;
  company_name: string;
  icris_number: string | null;
  segment: string | null;
  shipments: number;
  awaiting_cost_shipments: number;
  awaiting_cost_bill: number;
  bill_amount: number;
  ups_bill_amount: number;
  profit_loss: number;
  margin_percent: number | null;
}

export interface PnlRoute {
  route: string;
  mawb_count: number;
  bill_amount: number;
  ups_bill_amount: number;
  profit_loss: number;
}

export interface MawbDetail extends MawbSummary {
  shipments: Shipment[];
  carrier_name: string;
  billing_breakdown: Record<string, { count: number; weight: number }>;
}

export interface AccountExecutive {
  id: string;
  ae_code: string;
  display_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  assigned_customer_count: number;
}

export interface AeReassignmentLogEntry {
  id: string;
  created_at: string;
  company_id: string;
  from_ae_code: string | null;
  to_ae_code: string | null;
  reason: string | null;
  source: string;
  shipments_updated: number;
}

export interface AeImportPreview {
  file_name: string;
  worksheet_name: string;
  headers: string[];
  total_rows: number;
  valid_rows: number;
  blank_icris_count: number;
  invalid_icris_count: number;
  unknown_ae_count: number;
  unknown_ae_values: string[];
  duplicate_icris_count: number;
  duplicate_groups: { normalized_icris: string; row_numbers: number[] }[];
  matched_count: number;
  unmatched_icris_count: number;
  to_reassign_count: number;
  unchanged_count: number;
  unmatched_icris_preview: { row_number: number; icris: string; customer_name: string }[];
  unknown_ae_preview: { row_number: number; ae_raw: string; customer_name: string }[];
  preview_rows: Record<string, any>[];
}

export interface AeImportBatch {
  id: string;
  created_at: string;
  file_name: string;
  worksheet_name: string;
  total_rows: number;
  matched_count: number;
  reassigned_count: number;
  unchanged_count: number;
  unmatched_icris_count: number;
  unknown_ae_count: number;
  invalid_row_count: number;
  status: string;
  completed_at: string | null;
}

export interface AeImportRow {
  id: string;
  row_number: number;
  raw_data_json: Record<string, any>;
  processing_status: 'reassigned' | 'unchanged' | 'unmatched' | 'duplicate' | 'rejected';
  error_message: string | null;
  company_id: string | null;
}

export interface CompanyConflict {
  source_id: string;
  source_icris_number: string;
  source_company_name: string;
  source_created_at: string;
  target_id: string;
  target_icris_number: string;
  target_company_name: string;
  score: number;
  match_reason: 'exact_name' | 'prefix' | 'fuzzy';
  confidence: 'high' | 'medium' | 'low';
  other_candidates: number;
  source_shipment_count: number;
  target_shipment_count: number;
  source_document_count: number;
}

export interface DataQualityTypeSummary {
  issue_type: string;
  severity: string;
  open_count: number;
  reviewed_count: number;
  resolved_count: number;
  ignored_count: number;
  total_count: number;
  affected_companies: number;
  last_seen_at: string | null;
}

export interface DataQualitySummary {
  totals: {
    total: number;
    open: number;
    open_errors: number;
    open_warnings: number;
    closed: number;
    affected_companies: number;
    affected_shipments: number;
  };
  by_type: DataQualityTypeSummary[];
  top_companies: { company_name: string; company_id: string | null; icris_number: string | null; open_count: number }[];
  // ICRIS Number Mismatch and Blank ICRIS are only genuinely "self-resolving" within the
  // normal accounts->CRM billing lag (icris_buffer_days). Past that, they're stuck — this
  // breaks out how much of it (and how much real revenue) falls in each bucket.
  // crm_icris_not_in_master is tracked separately (icris_not_in_master_open) since it's
  // waiting on a company-master import, not accounting.
  icris_buffer_age: { state: 'pending' | 'stuck'; open_count: number; revenue_at_risk: number }[];
  icris_buffer_days: number;
  icris_not_in_master_open: number;
}

export interface DataQualityIssue {
  id: string;
  issue_type: string;
  severity: string;
  company_id: string | null;
  shipment_id: string | null;
  mawb_id: string | null;
  sync_run_id: string | null;
  source_icris_number: string | null;
  source_company_name: string | null;
  details_json: any;
  status: 'open' | 'reviewed' | 'resolved' | 'ignored';
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  linked_shipment_date: string | null;
  icris_buffer_state: 'pending' | 'stuck' | null;
  revenue_at_risk: number;
}

export interface DataQualityResolutionLogEntry {
  id: string;
  issue_type: string;
  resolved_by: string | null;
  first_seen_at: string;
  resolved_at: string;
  before_icris: string | null;
  before_company_name: string | null;
  after_icris: string | null;
  after_company_name: string | null;
  after_is_provisional: boolean | null;
  days_to_resolve: number;
}

/**
 * Query params shared by every /analytics/* endpoint (backend/app/main.py: executive-dashboard,
 * ae-performance, geography, operations all accept this same base set via get_timeframe_bounds()).
 * Page-specific extras (origin/destination/mawb/export_only/min_revenue/...) extend this.
 */
export interface AnalyticsFilterParams {
  timeframe?: string;
  date_from?: string;
  date_to?: string;
  year_from?: number;
  year_to?: number;
  compare_mode?: string;
  ae_code?: string;
  segment?: string;
  country?: string;
}

export interface PipelineItem {
  id: string;
  expected_date: string;
  company_name: string;
  icris_number: string | null;
  country: string | null;
  weight_kg: number | null;
  revenue_usd: number | null;
  pieces: number | null;
  category: string | null;
  ae_code: string | null;
  win_loss: string | null;
  remarks: string | null;
  is_overdue: boolean;
  is_lost: boolean;
  scraped_at: string;
}

export interface PipelineListResponse {
  items: PipelineItem[];
  total: number;
  overdue_count: number;
  lost_count: number;
  as_of: string | null;
}

// Shape of crm_run_payload() in main.py — a full CrmSyncRun column dump plus computed
// progress. Typed with just the fields the CrmSync page reads; the run itself carries many
// more (manifest-sync-only) columns that a pipeline run leaves null.
export interface CrmSyncRunPayload {
  id: string;
  sync_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  warnings_count: number;
  dry_run: boolean;
}

export interface CallLog {
  id: string;
  call_date: string;
  company_name: string;
  crm_customer_id: string | null;
  stage: string | null;
  category: string | null;
  contact_person: string | null;
  phone: string | null;
  call_type: string | null;
  ae_code: string | null;
  remarks: string | null;
  supervisor_comment: string | null;
  follow_up_date: string | null;
  scraped_at: string;
}

export interface CallLogListResponse {
  items: CallLog[];
  total: number;
  as_of?: string | null;
}

export interface AeTarget {
  id: string;
  ae_code: string;
  year: number;
  month: number;
  weight_target: number | null;
  piece_target: number | null;
  revenue_target: number | null;
  weight_target_import: number | null;
  piece_target_import: number | null;
  revenue_target_import: number | null;
  source: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AeTargetInput {
  ae_code: string;
  year: number;
  month: number;
  weight_target?: number | null;
  piece_target?: number | null;
  revenue_target?: number | null;
  weight_target_import?: number | null;
  piece_target_import?: number | null;
  revenue_target_import?: number | null;
  notes?: string | null;
}

export interface KeyInsight {
  id: string;
  category: string;
  type: string;
  severity: string;
  title: string;
  description: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  metric_value: number | null;
  date: string;
  occurred_at: string;
  ae_code: string | null;
  seen: boolean;
}

export const api = {
  getAlerts: async () => { const res = await apiClient.get('/analytics/alerts'); return res.data; },
  getKeyInsights: async (category?: string): Promise<{ items: KeyInsight[]; unread_count: number; categories: string[] }> => {
    const res = await apiClient.get('/notifications/key-insights', { params: category ? { category } : undefined });
    return res.data;
  },
  markInsightsSeen: async (ids: string[]): Promise<void> => {
    await apiClient.post('/notifications/mark-seen', { ids });
  },
  markAllInsightsSeen: async (): Promise<{ marked: number }> => {
    const res = await apiClient.post('/notifications/mark-all-seen');
    return res.data;
  },
  snoozeInsight: async (id: string, days: number | null): Promise<void> => {
    await apiClient.post('/notifications/snooze', { id, days });
  },
  // Re-applies customer-segmentation-rules.md to every company. Admin-only.
  recomputeCustomerSegments: async (): Promise<{ tier_counts: Record<string, number> }> => {
    const res = await apiClient.post('/admin/customers/recompute-segments');
    return res.data;
  },
  // Resend digest for Tier Shipping Gap alerts. Admin-only. Returns a summary even if
  // sending is disabled (no RESEND_API_KEY / TIER_ALERT_EMAIL_ENABLED=false) so the UI
  // can show what's pending either way.
  sendTierAlertEmails: async (): Promise<{
    enabled: boolean; total_breaches: number; ae_emails_sent: number;
    admin_emails_sent: number; ae_codes_without_email: string[];
  }> => {
    const res = await apiClient.post('/admin/tier-alerts/send-emails');
    return res.data;
  },
  // Executive Dashboard endpoint (used for both Overview and Analytics Workspace)
  getExecutiveDashboard: async (params?: AnalyticsFilterParams & {
    destination?: string;
    min_revenue?: number;
    max_revenue?: number;
    min_shipments?: number;
    max_shipments?: number;
  }): Promise<DashboardResponse> => {
    const response = await apiClient.get('/analytics/executive-dashboard', { params });
    return response.data;
  },

  getGeographyDashboard: async (params?: AnalyticsFilterParams & {
    origin?: string;
    destination?: string;
    export_only?: boolean;
    destinations_limit?: number;
  }): Promise<any> => {
    const response = await apiClient.get('/analytics/geography', { params });
    return response.data;
  },

  // DOC vs NON-DOC shipment breakdown, sourced from the CRM's own 'Bill Type' column
  // (Document/Letter -> doc, Non-Doc -> non_doc, blank -> unclassified).
  getDocumentTypeDashboard: async (params?: AnalyticsFilterParams): Promise<any> => {
    const response = await apiClient.get('/analytics/document-type', { params });
    return response.data;
  },

  // AE Performance endpoint
  getAEPerformance: async (params?: AnalyticsFilterParams): Promise<AEPerformanceResponse> => {
    const response = await apiClient.get('/analytics/ae-performance', { params });
    return response.data;
  },

  // Gamified AE leaderboard — unscoped (every role sees the same board), fixed to the
  // current month. Distinct from getAEPerformance, which is the admin/sales_lead
  // drill-down and is row-scoped per AE for 'ae'-role callers. `params` (timeframe/
  // date_from/date_to, the same shape as the shared DateRangeControl) only takes
  // effect for admin/super_admin — the backend ignores it for every other role.
  getLeaderboard: async (params?: LeaderboardParams): Promise<LeaderboardResponse> => {
    const response = await apiClient.get('/leaderboard', { params });
    return response.data;
  },

  getTopCustomers: async (params?: { timeframe?: string; date_from?: string; date_to?: string; metric?: 'revenue' | 'shipments' | 'weight'; limit?: number }): Promise<{
    metric: string;
    bounds: { c_start: string; c_end: string; p_start: string; p_end: string };
    items: { rank: number; company_id: string; company_name: string; icris_number: string; segment: string | null; revenue: number; shipments: number; weight: number; pct_growth: number }[];
  }> => {
    const response = await apiClient.get('/analytics/top-customers', { params });
    return response.data;
  },

  // Assign AE
  assignAE: async (companyId: string, ae_code: string, reason?: string) => {
    const response = await apiClient.post(`/companies/${companyId}/assign-ae`, { ae_code, reason });
    return response.data;
  },
  getCompanyAeHistory: async (companyId: string): Promise<AeReassignmentLogEntry[]> => {
    const response = await apiClient.get(`/companies/${companyId}/ae-history`);
    return response.data;
  },
  getAccountExecutives: async (activeOnly = false): Promise<AccountExecutive[]> => {
    const response = await apiClient.get('/account-executives', { params: { active_only: activeOnly } });
    return response.data;
  },
  updateAccountExecutive: async (aeCode: string, data: { display_name?: string; is_active?: boolean }): Promise<AccountExecutive> => {
    const response = await apiClient.patch(`/account-executives/${aeCode}`, data);
    return response.data;
  },
  previewAeImport: async (file: File, worksheet?: string): Promise<AeImportPreview> => {
    const formData = new FormData();
    formData.append('file', file);
    if (worksheet) formData.append('worksheet', worksheet);
    const response = await apiClient.post('/ae-imports/preview', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    return response.data;
  },
  commitAeImport: async (file: File, worksheet?: string): Promise<AeImportBatch> => {
    const formData = new FormData();
    formData.append('file', file);
    if (worksheet) formData.append('worksheet', worksheet);
    const response = await apiClient.post('/ae-imports', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    return response.data;
  },
  getAeImportBatches: async (): Promise<AeImportBatch[]> => {
    const response = await apiClient.get('/ae-imports');
    return response.data;
  },
  getAeImportRows: async (batchId: string, status?: string): Promise<AeImportRow[]> => {
    const response = await apiClient.get(`/ae-imports/${batchId}/rows`, { params: { status, limit: 1000 } });
    return response.data;
  },

  // Destinations endpoint
  getDestinations: async () => {
    const response = await apiClient.get('/analytics/destinations');
    return response.data;
  },

  // Universal Search endpoint
  search: async (query: string): Promise<SearchResponse> => {
    const response = await apiClient.get(`/search`, { params: { q: query, limit: 20 } });
    return response.data;
  },

  // -- Companies ----------------------------------------------------

  getCompanies: async (params?: {
    q?: string;
    status?: string;
    customer_type?: string;
    inactivity_status?: string;
    pay_term?: string;
    has_shipments?: boolean;
    has_documents?: boolean;
    country?: string;
    ae_code?: string;
    min_revenue?: number;
    max_revenue?: number;
    min_shipments?: number;
    max_shipments?: number;
    min_weight?: number;
    max_weight?: number;
    limit?: number;
    offset?: number;
  }): Promise<CompanyListResponse> => {
    const response = await apiClient.get('/companies', { params });
    return response.data;
  },

  getCompany: async (companyId: string): Promise<CompanyDetail> => {
    const response = await apiClient.get(`/companies/${companyId}`);
    return response.data;
  },
  createCompany: async (data: {
    icris_number: string; company_name: string; legal_name?: string; phone?: string; email?: string;
    address?: string; pan_vat_number?: string; customer_type?: string; status?: string; notes?: string;
  }): Promise<CompanyDetail> => {
    const response = await apiClient.post('/companies', data);
    return response.data;
  },

  updateCompany: async (companyId: string, data: Record<string, unknown>): Promise<CompanyDetail> => {
    const response = await apiClient.patch(`/companies/${companyId}`, data);
    return response.data;
  },

  deleteCompany: async (companyId: string): Promise<void> => {
    await apiClient.delete(`/companies/${companyId}`);
  },



  getCompanyShipments: async (companyId: string): Promise<CompanyShipment[]> => {
    const response = await apiClient.get(`/companies/${companyId}/shipments`);
    return response.data;
  },

  getCompanyDocuments: async (companyId: string, params?: { q?: string; category?: string; status?: string }): Promise<CompanyDocument[]> => {
    const response = await apiClient.get(`/companies/${companyId}/documents`, { params });
    return response.data;
  },

  getCompanyCallLogs: async (companyId: string): Promise<CallLogListResponse> => {
    const response = await apiClient.get(`/companies/${companyId}/call-logs`);
    return response.data;
  },

  // ── Shipments ──────────────────────────────────────────────

  getShipments: async (params?: Record<string, any> & { min_weight?: number; max_weight?: number }): Promise<{ items: Shipment[]; total: number; limit: number; offset: number }> => {
    const response = await apiClient.get('/shipments', { params });
    return response.data;
  },

  getShipment: async (shipmentId: string): Promise<Shipment & { mawb: MawbSummary | null; packages: any[] }> => {
    const response = await apiClient.get(`/shipments/${shipmentId}`);
    return response.data;
  },

  getShipmentStats: async (params?: Record<string, any>): Promise<any> => {
    const response = await apiClient.get('/shipments/stats', { params });
    return response.data;
  },

  getShipmentPackages: async (shipmentId: string): Promise<any[]> => {
    const response = await apiClient.get(`/shipments/${shipmentId}/packages`);
    return response.data;
  },

  getShipmentActivity: async (id: string): Promise<ActivityLog[]> => {
    const { data } = await apiClient.get(`/shipments/${id}/activity`);
    return data;
  },

  getMawbs: async (params?: any): Promise<{ items: MawbSummary[]; total: number; limit: number; offset: number }> => {
    const { data } = await apiClient.get(`/mawbs`, { params });
    return data;
  },

  getMawbDetail: async (id: string): Promise<MawbDetail> => {
    const { data } = await apiClient.get(`/mawbs/${id}`);
    return data;
  },

  getMawbPnlSummary: async (params?: { manifest_date_from?: string; manifest_date_to?: string }): Promise<{
    mawb_count: number; bill_amount: number; ups_bill_amount: number; profit_loss: number; last_synced_at: string | null;
    avg_margin_percent: number;
    best_margin_mawb: PnlMawbRef | null;
    worst_margin_mawb: PnlMawbRef | null;
    highest_profit_mawb: PnlMawbRef | null;
    awaiting_cost_shipments: number;
    awaiting_cost_bill: number;
    shipment_detail_available: boolean;
  }> => {
    const { data } = await apiClient.get('/mawbs/pnl-summary', { params });
    return data;
  },

  getMawbPnlTrend: async (params: { manifest_date_from: string; manifest_date_to: string; granularity?: 'day' | 'week' | 'month' }): Promise<PnlTrendPoint[]> => {
    const { data } = await apiClient.get('/mawbs/pnl-trend', { params });
    return data;
  },

  getMawbPnlRoutes: async (params?: { manifest_date_from?: string; manifest_date_to?: string; limit?: number }): Promise<PnlRoute[]> => {
    const { data } = await apiClient.get('/mawbs/pnl-routes', { params });
    return data;
  },

  getCustomerProfitability: async (params?: { timeframe?: string; date_from?: string; date_to?: string; sort?: 'profit' | 'margin' | 'bill' | 'loss'; limit?: number }): Promise<{
    sort: string;
    bounds: { c_start: string; c_end: string } | null;
    date_from: string | null;
    date_to: string | null;
    items: CustomerProfitability[];
  }> => {
    const { data } = await apiClient.get('/analytics/customer-profitability', { params });
    return data;
  },

  syncUpsPnl: async (data: { date_from: string; date_to: string; dry_run?: boolean; maximum_manifests?: number }): Promise<any> => {
    const response = await apiClient.post('/crm-sync/ups-pnl', data);
    return response.data;
  },

  uploadCompanyDocument: async (
    companyId: string,
    file: File,
    title: string,
    category: string = 'other',
    description?: string
  ): Promise<CompanyDocument> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title);
    formData.append('category', category);
    if (description) formData.append('description', description);

    const response = await apiClient.post(`/companies/${companyId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  updateDocument: async (documentId: string, data: { title?: string; category?: string; description?: string }): Promise<CompanyDocument> => {
    const response = await apiClient.patch(`/documents/${documentId}`, data);
    return response.data;
  },

  archiveDocument: async (documentId: string): Promise<{ status: string; id: string }> => {
    const response = await apiClient.delete(`/documents/${documentId}`);
    return response.data;
  },

  getCompanyStorageStats: async (companyId: string): Promise<CompanyStorageStats> => {
    const response = await apiClient.get(`/companies/${companyId}/storage-stats`);
    return response.data;
  },

  getCompanyAnalytics: async (companyId: string, params?: {
    timeframe?: string;
    date_from?: string;
    date_to?: string;
    destination?: string;
  }): Promise<CompanyAnalytics> => {
    const response = await apiClient.get(`/companies/${companyId}/analytics`, { params });
    return response.data;
  },

  getCompanyActivity: async (companyId: string): Promise<ActivityLog[]> => {
    const response = await apiClient.get(`/companies/${companyId}/activity`);
    return response.data;
  },

  getCompanyAliases: async (companyId: string): Promise<CompanyAlias[]> => {
    const response = await apiClient.get(`/companies/${companyId}/aliases`);
    return response.data;
  },

  downloadCompanyDossier: async (
    companyId: string,
    companyName: string,
    params?: { date_from?: string; date_to?: string; timeframe_label?: string }
  ): Promise<void> => {
    const response = await apiClient.get(`/companies/${companyId}/dossier-pdf`, {
      params,
      responseType: 'blob',
    });
    const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `Customer360_Dossier_${companyName.replace(/[^a-z0-9]+/gi, '_')}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  addCompanyAlias: async (companyId: string, aliasName: string): Promise<CompanyAlias> => {
    const response = await apiClient.post(`/companies/${companyId}/aliases`, { alias_name: aliasName });
    return response.data;
  },

  deleteCompanyAlias: async (companyId: string, aliasId: string): Promise<void> => {
    await apiClient.delete(`/companies/${companyId}/aliases/${aliasId}`);
  },

  // ── CRM Sync ─────────────────────────────────────────────

  getCrmStatus: async (): Promise<any> => {
    const response = await apiClient.get('/crm-sync/status');
    return response.data;
  },

  syncNow: async (direction = 'both', overlapDays = 3): Promise<any> => {
    const response = await apiClient.post('/crm-sync/sync-now', null, { params: { direction, overlap_days: overlapDays } });
    return response.data;
  },

  getBackfills: async (): Promise<any[]> => {
    const response = await apiClient.get('/crm-sync/backfills');
    return response.data;
  },

  getSyncRuns: async (limit = 20): Promise<any[]> => {
    const response = await apiClient.get('/crm-sync/runs', { params: { limit } });
    return response.data;
  },

  getSyncRun: async (runId: string): Promise<any> => {
    const response = await apiClient.get(`/crm-sync/runs/${runId}`);
    return response.data;
  },

  // Re-fetches one manifest's detail page live from the CRM (bypassing the checksum-skip that
  // otherwise leaves an already-synced manifest untouched) — for when the CRM source itself
  // was corrected after the fact, e.g. an ICRIS filled in on a row that was blank at sync time.
  recheckManifest: async (crmManifestId: number): Promise<any> => {
    const response = await apiClient.post(`/crm-sync/export/${crmManifestId}`, null, { params: { force_reparse: true } });
    return response.data;
  },

  diagnose: async (): Promise<any> => {
    const response = await apiClient.get('/crm-sync/diagnose');
    return response.data;
  },

  rematch: async (): Promise<any> => {
    const response = await apiClient.post('/crm-sync/rematch');
    return response.data;
  },

  syncPnl: async (data: { date_from: string; date_to: string; dry_run?: boolean }): Promise<any> => {
    const response = await apiClient.post('/crm-sync/pnl', data);
    return response.data;
  },

  getAeTargets: async (params?: { year?: number; ae_code?: string }): Promise<AeTarget[]> => {
    const { data } = await apiClient.get('/ae-targets', { params });
    return data;
  },

  upsertAeTarget: async (body: AeTargetInput): Promise<AeTarget> => {
    const { data } = await apiClient.post('/ae-targets', body);
    return data;
  },

  patchAeTarget: async (id: string, body: Partial<AeTargetInput>): Promise<AeTarget> => {
    const { data } = await apiClient.patch(`/ae-targets/${id}`, body);
    return data;
  },

  deleteAeTarget: async (id: string): Promise<void> => {
    await apiClient.delete(`/ae-targets/${id}`);
  },

  importAeTargets: async (file: File): Promise<{ file_name: string; worksheet_name: string; total_rows: number; created: number; updated: number; unknown_ae_count: number; unknown_ae_values: string[]; invalid_row_count: number }> => {
    const form = new FormData();
    form.append('file', file);
    const { data } = await apiClient.post('/ae-targets/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return data;
  },

  getPipeline: async (params?: { ae_code?: string; overdue_only?: boolean; lost_only?: boolean }): Promise<PipelineListResponse> => {
    const { data } = await apiClient.get('/pipeline', { params });
    return data;
  },

  syncPipeline: async (data?: { date_from?: string; date_to?: string; dry_run?: boolean }): Promise<CrmSyncRunPayload> => {
    const response = await apiClient.post('/crm-sync/active-pipeline', data ?? {});
    return response.data;
  },

  launchBackfill: async (data: {
    direction: string; start_date?: string; end_date?: string; chunk_size_days?: number;
  }): Promise<any> => {
    const response = await apiClient.post('/crm-sync/backfills', data);
    return response.data;
  },

  // Data Quality & Matching Endpoints
  getMatchingReview: async (): Promise<any[]> => {
    const { data } = await apiClient.get('/matching-review');
    return data;
  },

  getMatchingDetail: async (id: string): Promise<any> => {
    const { data } = await apiClient.get(`/matching-review/${id}`);
    return data;
  },

  linkMatching: async (shipmentId: string, companyId: string, saveAsAlias: boolean = false): Promise<any> => {
    const { data } = await apiClient.post(`/matching-review/${shipmentId}/link`, { company_id: companyId, save_as_alias: saveAsAlias });
    return data;
  },

  rejectMatching: async (shipmentId: string): Promise<any> => {
    const { data } = await apiClient.post(`/matching-review/${shipmentId}/reject-suggestion`);
    return data;
  },

  getOperationalDashboard: async (params?: AnalyticsFilterParams & {
    origin?: string;
    destination?: string;
    mawb?: string;
    export_only?: boolean;
  }): Promise<any> => {
    const { data } = await apiClient.get('/analytics/operations', { params });
    return data;
  },

  getDataQualityIssues: async (params?: {
    issue_type?: string; severity?: string; status?: string; company_id?: string;
    q?: string; icris_buffer_state?: 'pending' | 'stuck'; sort?: 'revenue';
    limit?: number; offset?: number;
  }): Promise<{ items: DataQualityIssue[]; total: number; limit: number; offset: number }> => {
    const res = await apiClient.get('/data-quality/issues', { params });
    return res.data;
  },
  getDataQualitySummary: async (): Promise<DataQualitySummary> => {
    const res = await apiClient.get('/data-quality/summary');
    return res.data;
  },
  getDataQualityResolutionLog: async (params?: {
    issue_type?: string; resolved_by?: string; days?: number; limit?: number; offset?: number;
  }): Promise<{ items: DataQualityResolutionLogEntry[]; total: number; limit: number; offset: number }> => {
    const res = await apiClient.get('/data-quality/resolution-log', { params });
    return res.data;
  },
  bulkPatchDataQualityIssues: async (body: {
    status: string; issue_type?: string; severity?: string; current_status?: string;
    company_id?: string; ids?: string[]; reason?: string;
  }): Promise<{ status: string; updated: number }> => {
    const res = await apiClient.post('/data-quality/issues/bulk-status', body);
    return res.data;
  },
  getCompanyConflicts: async () => {
    const res = await apiClient.get<CompanyConflict[]>('/quality-issues/company-conflicts');
    return res.data;
  },
  mergeCompanies: async (sourceId: string, targetId: string) => {
    const res = await apiClient.post(`/companies/${sourceId}/merge/${targetId}`);
    return res.data;
  },

  patchDataQualityIssue: async (id: string, status: string, reason?: string): Promise<DataQualityIssue> => {
    const { data } = await apiClient.patch(`/data-quality/issues/${id}`, { status, reason });
    return data;
  },

  fixDataQualityIssue: async (id: string, body: {
    action: 'assign_company' | 'set_field' | 'save_alias' | 'rename_company' | 'merge' | 'acknowledge';
    company_id?: string; target_id?: string; field?: string; value?: string; company_name?: string;
  }): Promise<DataQualityIssue> => {
    const { data } = await apiClient.post(`/data-quality/issues/${id}/fix`, body);
    return data;
  }
};

// ── Administration ────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: AuthRole;
  ae_code: string | null;
  is_active: boolean;
  has_password: boolean;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
  setup_link?: string;
}

export interface AdminUserPatch {
  display_name?: string;
  role?: AuthRole;
  ae_code?: string | null;
  is_active?: boolean;
}

export interface NewUserRow {
  email: string;
  display_name: string;
  role: AuthRole;
  ae_code?: string | null;
}

export interface BulkCreateUserResult {
  row: number;
  email: string;
  status: 'created' | 'error';
  user?: AdminUser;
  error?: string;
}

export const adminApi = {
  getUsers: async (params?: { q?: string; role?: string; is_active?: boolean; limit?: number; offset?: number }): Promise<{ items: AdminUser[]; total: number; limit: number; offset: number }> => {
    const { data } = await apiClient.get('/admin/users', { params });
    return data;
  },

  createUser: async (body: NewUserRow): Promise<AdminUser> => {
    const { data } = await apiClient.post('/admin/users', body);
    return data;
  },

  bulkCreateUsers: async (users: NewUserRow[]): Promise<{ results: BulkCreateUserResult[]; created_count: number; error_count: number }> => {
    const { data } = await apiClient.post('/admin/users/bulk', { users });
    return data;
  },

  issueSetupLink: async (userId: string): Promise<{ setup_link: string }> => {
    const { data } = await apiClient.post(`/admin/users/${userId}/setup-link`);
    return data;
  },

  updateUser: async (userId: string, body: AdminUserPatch): Promise<AdminUser> => {
    const { data } = await apiClient.patch(`/admin/users/${userId}`, body);
    return data;
  },

  getAuditLogs: async (params?: { entity_type?: string; action?: string; q?: string; date_from?: string; date_to?: string; limit?: number; offset?: number }): Promise<{ items: ActivityLog[]; total: number; limit: number; offset: number }> => {
    const { data } = await apiClient.get('/admin/audit-logs', { params });
    return data;
  },
};
