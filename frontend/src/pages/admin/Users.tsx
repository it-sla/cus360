import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminApi, api, type AdminUser, type AuthRole, type NewUserRow, type BulkCreateUserResult } from '../../api';
import { useAuth } from '@/auth';
import { Search, Plus, Users as UsersIcon, X, MoreVertical, ShieldCheck, UserX, UserCheck, KeyRound, Copy, Check, Trash2, ClipboardPaste } from 'lucide-react';

const PAGE_SIZE = 25;

const ROLE_LABELS: Record<string, string> = { super_admin: 'Super Admin', admin: 'Admin', sales_lead: 'Sales Lead', ae: 'AE', user: 'User' };
const ROLE_STYLES: Record<string, string> = {
  super_admin: 'bg-rose-50 text-rose-700 border-rose-200',
  admin: 'bg-purple-50 text-purple-700 border-purple-200',
  sales_lead: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  ae: 'bg-sky-50 text-sky-700 border-sky-200',
  user: 'bg-slate-100 text-slate-600 border-slate-200',
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${ROLE_STYLES[role] || ROLE_STYLES.user}`}>
      {(role === 'admin' || role === 'super_admin') && <ShieldCheck size={11} />}
      {ROLE_LABELS[role] || role}
    </span>
  );
}

function StatusBadge({ isActive, hasPassword }: { isActive: boolean; hasPassword: boolean }) {
  if (!isActive) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Inactive</span>;
  if (!hasPassword) return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">Pending activation</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Active</span>;
}

function CopyLinkRow({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // navigator.clipboard needs a "secure context" (HTTPS or localhost) — this app is
  // reachable over plain HTTP on the office LAN (192.168.101.244:3600), where that API
  // is simply unavailable and silently rejects. execCommand('copy') has no such
  // restriction, so it's the fallback rather than the primary path's error case.
  const copy = async () => {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(link);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok && inputRef.current) {
      inputRef.current.select();
      inputRef.current.setSelectionRange(0, link.length);
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      inputRef.current.blur();
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2">
      <input
        ref={inputRef}
        readOnly
        value={link}
        onFocus={e => e.target.select()}
        className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-slate-600 truncate outline-none"
      />
      <button onClick={copy} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-slate-200 text-[10px] font-bold text-slate-600 hover:bg-slate-100">
        {copied ? <><Check size={11} className="text-emerald-600" /> Copied</> : <><Copy size={11} /> Copy</>}
      </button>
    </div>
  );
}

const emptyRow = (): NewUserRow => ({ email: '', display_name: '', role: 'user', ae_code: '' });

export default function Users() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showRowMenuId, setShowRowMenuId] = useState<string | null>(null);

  // Single add / edit modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'add' | 'edit'>('add');
  const [modalForm, setModalForm] = useState({ id: '', email: '', display_name: '', role: 'user' as AuthRole, ae_code: '', email_alerts_enabled: true });
  const [modalError, setModalError] = useState('');
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [editSetupLink, setEditSetupLink] = useState<string | null>(null);

  // Bulk add modal
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [bulkRows, setBulkRows] = useState<NewUserRow[]>([emptyRow(), emptyRow()]);
  const [pasteText, setPasteText] = useState('');
  const [bulkResults, setBulkResults] = useState<BulkCreateUserResult[] | null>(null);

  const { data: aeList } = useQuery({
    queryKey: ['account-executives-for-user-assignment'],
    queryFn: () => api.getAccountExecutives(true),
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-users', searchQuery, roleFilter, statusFilter, page],
    queryFn: () => adminApi.getUsers({
      q: searchQuery || undefined,
      role: roleFilter || undefined,
      is_active: statusFilter ? statusFilter === 'active' : undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const createMutation = useMutation({
    mutationFn: (body: NewUserRow) => adminApi.createUser(body),
    onSuccess: (u) => { queryClient.invalidateQueries({ queryKey: ['admin-users'] }); setCreatedLink(u.setup_link || null); },
    onError: (err: any) => setModalError(err?.response?.data?.detail || 'Failed to create user'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; display_name?: string; role?: AuthRole; ae_code?: string | null; is_active?: boolean; email_alerts_enabled?: boolean }) => adminApi.updateUser(id, body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-users'] }); setShowRowMenuId(null); },
    onError: (err: any) => alert(err?.response?.data?.detail || 'Failed to update user'),
  });

  const setupLinkMutation = useMutation({
    mutationFn: (userId: string) => adminApi.issueSetupLink(userId),
    onSuccess: (res) => { setEditSetupLink(res.setup_link); queryClient.invalidateQueries({ queryKey: ['admin-users'] }); },
    onError: (err: any) => alert(err?.response?.data?.detail || 'Failed to generate setup link'),
  });

  const bulkCreateMutation = useMutation({
    mutationFn: (users: NewUserRow[]) => adminApi.bulkCreateUsers(users),
    onSuccess: (res) => { queryClient.invalidateQueries({ queryKey: ['admin-users'] }); setBulkResults(res.results); },
    onError: (err: any) => alert(err?.response?.data?.detail || 'Bulk creation failed'),
  });

  const openAddModal = () => {
    setModalMode('add');
    setModalForm({ id: '', email: '', display_name: '', role: 'user', ae_code: '', email_alerts_enabled: true });
    setModalError('');
    setCreatedLink(null);
    setIsModalOpen(true);
  };

  const openEditModal = (u: AdminUser) => {
    setModalMode('edit');
    setModalForm({ id: u.id, email: u.email, display_name: u.display_name, role: u.role, ae_code: u.ae_code || '', email_alerts_enabled: u.email_alerts_enabled ?? true });
    setModalError('');
    setEditSetupLink(null);
    setIsModalOpen(true);
    setShowRowMenuId(null);
  };

  const submitModal = () => {
    setModalError('');
    if (modalForm.role === 'ae' && !modalForm.ae_code.trim()) {
      setModalError('AE role requires an AE code — this is what scopes the account to its own data.');
      return;
    }
    if (modalMode === 'add') {
      if (!modalForm.email || !modalForm.display_name) {
        setModalError('Email and name are required');
        return;
      }
      createMutation.mutate({ email: modalForm.email, display_name: modalForm.display_name, role: modalForm.role, ae_code: modalForm.role === 'ae' ? modalForm.ae_code.trim() : null });
    } else {
      updateMutation.mutate({
        id: modalForm.id,
        display_name: modalForm.display_name,
        role: modalForm.role,
        ae_code: modalForm.role === 'ae' ? modalForm.ae_code.trim() : null,
        email_alerts_enabled: modalForm.email_alerts_enabled,
      });
    }
  };

  const toggleActive = (u: AdminUser) => {
    if (u.id === currentUser?.id) return;
    const verb = u.is_active ? 'deactivate' : 'reactivate';
    if (!confirm(`Are you sure you want to ${verb} ${u.display_name}?`)) return;
    updateMutation.mutate({ id: u.id, is_active: !u.is_active });
  };

  const openBulkModal = () => {
    setBulkRows([emptyRow(), emptyRow()]);
    setPasteText('');
    setBulkResults(null);
    setIsBulkOpen(true);
  };

  const updateBulkRow = (i: number, patch: Partial<NewUserRow>) => {
    setBulkRows(rows => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  };

  const addBulkRow = () => setBulkRows(rows => [...rows, emptyRow()]);
  const removeBulkRow = (i: number) => setBulkRows(rows => rows.filter((_, idx) => idx !== i));

  // Parses pasted lines like "email, display name, role, ae_code" (comma or tab
  // separated) into rows — role/ae_code are optional per line, defaulting to 'user'.
  const applyPaste = () => {
    const parsed = pasteText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\t|,/).map(p => p.trim());
        const role = (parts[2]?.toLowerCase() as AuthRole) || 'user';
        return { email: parts[0] || '', display_name: parts[1] || '', role: ['super_admin', 'admin', 'sales_lead', 'ae', 'user'].includes(role) ? role : 'user', ae_code: parts[3] || '' };
      })
      .filter(r => r.email);
    if (parsed.length) setBulkRows(parsed);
    setPasteText('');
  };

  const submitBulk = () => {
    const rows = bulkRows
      .filter(r => r.email.trim() && r.display_name.trim())
      .map(r => ({ ...r, email: r.email.trim(), display_name: r.display_name.trim(), ae_code: r.role === 'ae' ? (r.ae_code || '').trim() : null }));
    if (!rows.length) return;
    bulkCreateMutation.mutate(rows);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background relative">
      {isFetching && <div className="h-0.5 bg-gradient-to-r from-blue-400 via-indigo-500 to-blue-600 animate-pulse w-full sticky top-0 z-50" />}

      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">Users</h1>
            <p className="mt-1 text-xs sm:text-sm text-slate-500 font-medium">Manage who can access Customer 360 and what they can do. New users set their own password via a one-time link — nobody types it for them.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openBulkModal}
              className="h-9 px-4 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors text-xs font-semibold flex items-center gap-2"
            >
              <UsersIcon size={14} /> Add Users (Bulk)
            </button>
            <button
              onClick={openAddModal}
              className="h-9 px-4 rounded-lg bg-primary text-white hover:bg-blue-700 transition-colors text-xs font-semibold flex items-center gap-2"
            >
              <Plus size={14} /> Add User
            </button>
          </div>
        </div>

        <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-4 shadow-[0_2px_4px_rgba(15,23,42,0.04)] space-y-3">
          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                placeholder="Search by name or email..."
                className="w-full h-9 pl-9 pr-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 outline-none focus:border-primary focus:bg-white transition-all placeholder:text-slate-400 placeholder:font-medium"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={roleFilter}
                onChange={e => { setRoleFilter(e.target.value); setPage(1); }}
                className="h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer"
              >
                <option value="">All Roles</option>
                <option value="super_admin">Super Admin</option>
                <option value="admin">Admin</option>
                <option value="sales_lead">Sales Lead</option>
                <option value="ae">AE</option>
                <option value="user">User</option>
              </select>
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
                className="h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 cursor-pointer"
              >
                <option value="">All Statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              {(searchQuery || roleFilter || statusFilter) && (
                <button
                  onClick={() => { setSearchQuery(''); setRoleFilter(''); setStatusFilter(''); setPage(1); }}
                  className="text-xs font-semibold text-rose-500 hover:text-rose-700 px-2 transition-colors"
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-[16px] border border-[#E2E8F0] shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_30px_rgba(15,23,42,0.06)] overflow-hidden flex flex-col">
          <div className="overflow-x-auto min-h-[320px]">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/90 border-b border-slate-200">
                <tr className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Created</th>
                  <th className="px-4 py-2.5 text-right w-10">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  [...Array(6)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-32" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-40" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-14" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-14" /></td>
                      <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-20" /></td>
                      <td className="px-4 py-3" />
                    </tr>
                  ))
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-20 text-center text-slate-400">
                      No users match this filter.
                    </td>
                  </tr>
                ) : (
                  items.map(u => (
                    <tr key={u.id} className="transition-colors">
                      <td className="px-4 py-3 font-bold text-slate-900">
                        {u.display_name}
                        {u.id === currentUser?.id && <span className="ml-1.5 text-[9px] font-bold text-slate-400 uppercase">(you)</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.email}</td>
                      <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                      <td className="px-4 py-3"><StatusBadge isActive={u.is_active} hasPassword={u.has_password} /></td>
                      <td className="px-4 py-3 text-slate-500">{new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td className="px-4 py-3 text-right relative">
                        <button
                          onClick={() => setShowRowMenuId(showRowMenuId === u.id ? null : u.id)}
                          className="p-1 text-slate-400 hover:text-slate-800 rounded-md hover:bg-slate-100 transition-colors"
                        >
                          <MoreVertical size={16} />
                        </button>
                        {showRowMenuId === u.id && (
                          <>
                            <div className="fixed inset-0 z-20" onClick={() => setShowRowMenuId(null)} />
                            <div className="absolute right-4 top-9 w-52 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-1 text-left">
                              <button onClick={() => openEditModal(u)} className="w-full px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                                <KeyRound size={13} /> Edit
                              </button>
                              {u.id !== currentUser?.id && (
                                <button
                                  onClick={() => toggleActive(u)}
                                  className={`w-full px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 flex items-center gap-2 ${u.is_active ? 'text-rose-600' : 'text-emerald-600'}`}
                                >
                                  {u.is_active ? <><UserX size={13} /> Deactivate</> : <><UserCheck size={13} /> Reactivate</>}
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-5 py-3 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs font-medium text-slate-600">
              <span>Showing <strong>{(page - 1) * PAGE_SIZE + 1}</strong> to <strong>{Math.min(page * PAGE_SIZE, total)}</strong> of <strong>{total}</strong> users</span>
              <div className="flex items-center gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="px-3 py-1 bg-white border border-slate-200 rounded-md font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Previous</button>
                <span className="text-xs font-bold text-slate-800 px-2">Page {page} of {totalPages}</span>
                <button disabled={page === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="px-3 py-1 bg-white border border-slate-200 rounded-md font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Single add / edit modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">{modalMode === 'add' ? 'Add New User' : 'Edit User'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X size={20} />
              </button>
            </div>

            {modalMode === 'add' && createdLink ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs font-semibold">
                  <Check size={14} /> User created. Send them this one-time setup link so they can create their own password.
                </div>
                <CopyLinkRow link={createdLink} />
                <div className="flex justify-end pt-2">
                  <button onClick={() => setIsModalOpen(false)} className="px-4 py-2 bg-primary hover:bg-blue-700 text-white text-sm font-bold rounded-lg transition-colors">Done</button>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  {modalMode === 'add' && (
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Email *</label>
                      <input type="email" value={modalForm.email} onChange={e => setModalForm(f => ({ ...f, email: e.target.value }))} className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 outline-none focus:border-primary" placeholder="name@company.com" />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Display Name *</label>
                    <input type="text" value={modalForm.display_name} onChange={e => setModalForm(f => ({ ...f, display_name: e.target.value }))} className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 outline-none focus:border-primary" placeholder="e.g. Jane Doe" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Role</label>
                    <select
                      value={modalForm.role}
                      onChange={e => setModalForm(f => ({ ...f, role: e.target.value as AuthRole }))}
                      disabled={modalMode === 'edit' && modalForm.id === currentUser?.id}
                      className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 outline-none focus:border-primary disabled:opacity-50"
                    >
                      <option value="user">User</option>
                      <option value="ae">AE — own data only, no Profitability</option>
                      <option value="sales_lead">Sales Lead — everything except Data Integration/Administration</option>
                      <option value="admin">Admin — everything except Data Integration/Administration</option>
                      <option value="super_admin">Super Admin — full access, including Data Integration/Administration</option>
                    </select>
                  </div>
                  {modalForm.role === 'ae' && (
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">AE Code *</label>
                      <select
                        value={modalForm.ae_code}
                        onChange={e => setModalForm(f => ({ ...f, ae_code: e.target.value }))}
                        className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 outline-none focus:border-primary"
                      >
                        <option value="">Select an AE…</option>
                        {(aeList || []).map(ae => (
                          <option key={ae.ae_code} value={ae.ae_code}>{ae.ae_code}{ae.display_name ? ` — ${ae.display_name}` : ''}</option>
                        ))}
                      </select>
                      <p className="text-[11px] text-slate-500 mt-1">This is what scopes the account to its own data — the same code used on shipments/customers (Rankings, AE Performance).</p>
                    </div>
                  )}

                  {modalMode === 'edit' && (
                    <div className="flex items-center justify-between py-2 border border-slate-200 rounded-lg px-3 bg-slate-50">
                      <div>
                        <div className="text-xs font-bold text-slate-700">Email alerts</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">Tier alerts, breach notifications, and weekly reports</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setModalForm(f => ({ ...f, email_alerts_enabled: !f.email_alerts_enabled }))}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${modalForm.email_alerts_enabled ? 'bg-primary' : 'bg-slate-300'}`}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${modalForm.email_alerts_enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  )}
                  {modalMode === 'edit' && (
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Password</label>
                      {editSetupLink ? (
                        <CopyLinkRow link={editSetupLink} />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setupLinkMutation.mutate(modalForm.id)}
                          disabled={setupLinkMutation.isPending}
                          className="w-full h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <KeyRound size={13} /> {setupLinkMutation.isPending ? 'Generating…' : 'Generate password setup link'}
                        </button>
                      )}
                      <p className="text-[11px] text-slate-500 mt-1">Nobody types this user's password — they set it themselves via a one-time link you copy and send.</p>
                    </div>
                  )}

                  {modalError && <p className="text-xs font-semibold text-rose-600">{modalError}</p>}
                </div>

                <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
                  <button onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancel</button>
                  <button
                    onClick={submitModal}
                    disabled={createMutation.isPending || updateMutation.isPending}
                    className="px-4 py-2 bg-primary hover:bg-blue-700 text-white text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
                  >
                    {modalMode === 'add' ? (createMutation.isPending ? 'Creating…' : 'Create User') : (updateMutation.isPending ? 'Saving…' : 'Save Changes')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Bulk add modal */}
      {isBulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-800">Add Users (Bulk)</h2>
              <button onClick={() => setIsBulkOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X size={20} />
              </button>
            </div>

            {bulkResults ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">{bulkResults.filter(r => r.status === 'created').length} created</span>
                  {bulkResults.some(r => r.status === 'error') && (
                    <span className="text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2.5 py-1">{bulkResults.filter(r => r.status === 'error').length} failed</span>
                  )}
                </div>
                <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                  {bulkResults.map(r => (
                    <div key={r.row} className="border border-slate-200 rounded-lg p-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-slate-800">{r.email}</span>
                        {r.status === 'created'
                          ? <span className="text-[10px] font-bold text-emerald-600 uppercase">Created</span>
                          : <span className="text-[10px] font-bold text-rose-600 uppercase">Failed</span>}
                      </div>
                      {r.status === 'created' && r.user?.setup_link
                        ? <CopyLinkRow link={r.user.setup_link} />
                        : <p className="text-[11px] text-rose-600">{r.error}</p>}
                    </div>
                  ))}
                </div>
                <div className="flex justify-end pt-2 border-t border-slate-100">
                  <button onClick={() => setIsBulkOpen(false)} className="px-4 py-2 bg-primary hover:bg-blue-700 text-white text-sm font-bold rounded-lg transition-colors">Done</button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                    <ClipboardPaste size={12} /> Paste a list (optional) — one per line: email, name, role, ae code
                  </label>
                  <textarea
                    value={pasteText}
                    onChange={e => setPasteText(e.target.value)}
                    rows={3}
                    placeholder={'jane@company.com, Jane Doe, user\nak@company.com, Akrit K, ae, AK1'}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-mono text-slate-700 outline-none focus:border-primary"
                  />
                  <button onClick={applyPaste} disabled={!pasteText.trim()} className="mt-2 text-[11px] font-bold text-primary disabled:opacity-40">Apply to rows below →</button>
                </div>

                <div className="space-y-2">
                  {bulkRows.map((row, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 border border-slate-200 rounded-lg p-2">
                      <input type="email" value={row.email} onChange={e => updateBulkRow(i, { email: e.target.value })} placeholder="Email" className="flex-1 min-w-[160px] h-9 px-2.5 bg-slate-50 border border-slate-200 rounded-md text-xs outline-none focus:border-primary" />
                      <input type="text" value={row.display_name} onChange={e => updateBulkRow(i, { display_name: e.target.value })} placeholder="Display name" className="flex-1 min-w-[140px] h-9 px-2.5 bg-slate-50 border border-slate-200 rounded-md text-xs outline-none focus:border-primary" />
                      <select value={row.role} onChange={e => updateBulkRow(i, { role: e.target.value as AuthRole })} className="h-9 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs outline-none">
                        <option value="user">User</option>
                        <option value="ae">AE</option>
                        <option value="sales_lead">Sales Lead</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super Admin</option>
                      </select>
                      {row.role === 'ae' && (
                        <select value={row.ae_code || ''} onChange={e => updateBulkRow(i, { ae_code: e.target.value })} className="h-9 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs outline-none">
                          <option value="">AE code…</option>
                          {(aeList || []).map(ae => <option key={ae.ae_code} value={ae.ae_code}>{ae.ae_code}</option>)}
                        </select>
                      )}
                      <button onClick={() => removeBulkRow(i)} disabled={bulkRows.length <= 1} className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={addBulkRow} className="text-xs font-bold text-primary flex items-center gap-1"><Plus size={13} /> Add row</button>

                <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
                  <button onClick={() => setIsBulkOpen(false)} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">Cancel</button>
                  <button
                    onClick={submitBulk}
                    disabled={bulkCreateMutation.isPending || !bulkRows.some(r => r.email.trim() && r.display_name.trim())}
                    className="px-4 py-2 bg-primary hover:bg-blue-700 text-white text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
                  >
                    {bulkCreateMutation.isPending ? 'Creating…' : `Create ${bulkRows.filter(r => r.email.trim() && r.display_name.trim()).length || ''} Users`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
