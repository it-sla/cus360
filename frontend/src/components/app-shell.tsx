import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Separator from "@radix-ui/react-separator";
import {
  BarChart3, Search, Users, Package, FileText,
  ShieldCheck, Globe, ChevronDown, TrendingUp, Trophy, Medal,
  Bell, RefreshCw, CheckSquare, GitBranch, Target, Building2,
  LogOut, PanelLeftClose, PanelLeftOpen, UserCog, X, Plane, ArrowRight,
  DollarSign, UserCheck, Award, MapPin, FileStack, Activity,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from '@/auth';
import { api } from '@/api';
import type { KeyInsight, SearchResultItem } from '@/api';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

// Same icon map as UniversalSearch.tsx's result groups, kept minimal — anything not listed
// (e.g. 'package') falls back to Building2, same fallback UniversalSearch uses.
const SEARCH_RESULT_ICONS: Record<string, LucideIcon> = {
  company: Building2, mawb: Plane, shipment: Package, document: FileText,
};

type NavItem = {
  label: string;
  path: string;
  icon?: any;
  group?: string;
  subItems?: { label: string; path: string; icon?: any; }[];
  roles?: string[];
};

const NAV_ITEMS: NavItem[] = [
  // Executive
  { label: "Executive Overview", path: "/app", icon: BarChart3, group: "Executive" },
  {
    label: "Business Analytics",
    path: "/app/analytics",
    icon: Globe,
    group: "Executive",
    subItems: [
      { label: "Revenue Analytics", path: "/app/analytics#revenue", icon: DollarSign },
      { label: "Customer Analytics", path: "/app/customer-analytics", icon: UserCheck },
      { label: "AE Performance", path: "/app/ae-performance", icon: Award },
      { label: "Geography", path: "/app/geography", icon: MapPin },
      { label: "Document Type", path: "/app/doc-type", icon: FileStack },
      { label: "Operational KPIs", path: "/app/operations", icon: Activity },
    ]
  },
  { label: "Universal Search", path: "/app/search", icon: Search, group: "Executive" },

  // Customers
  { label: "Customer Directory", path: "/app/customers", icon: Users, group: "Customers" },

  // Operations
  { label: "Air Waybills", path: "/app/awb", icon: Package, group: "Operations" },
  { label: "Master Air Waybills", path: "/app/mawb", icon: FileText, group: "Operations" },

  // Intelligence
  { label: "Profitability", path: "/app/profitability", icon: TrendingUp, group: "Intelligence", roles: ['admin', 'sales_lead'] },
  { label: "Rankings", path: "/app/rankings", icon: Trophy, group: "Intelligence" },
  { label: "Leaderboard", path: "/app/leaderboard", icon: Medal, group: "Intelligence" },
  { label: "Alerts", path: "/app/alerts", icon: Bell, group: "Intelligence" },
  { label: "Active Pipeline", path: "/app/pipeline", icon: GitBranch, group: "Intelligence" },

  // Data & Integration
  { label: "CRM Sync", path: "/app/sync", icon: RefreshCw, group: "Data & Integration" },
  { label: "Matching Review", path: "/app/matching", icon: CheckSquare, group: "Data & Integration" },
  { label: "Data Quality", path: "/app/quality", icon: ShieldCheck, group: "Data & Integration" },

  // Administration
  { label: "Customer Management", path: "/app/customer-management", icon: Building2, group: "Administration" },
  { label: "AE Territory Assignment", path: "/app/ae-assignment", icon: Users, group: "Administration" },
  { label: "AE Revenue Targets", path: "/app/ae-targets", icon: Target, group: "Administration" },
  { label: "Users", path: "/app/users", icon: Users, group: "Administration" },
  { label: "Audit Logs", path: "/app/audit-logs", icon: FileText, group: "Administration" },
];

const GROUP_ORDER = ["Executive", "Customers", "Operations", "Intelligence", "Data & Integration", "Administration"];

function isItemActive(pathname: string, itemPath: string) {
  return pathname === itemPath || (itemPath !== '/app' && pathname.startsWith(itemPath));
}

function activeGroupFor(pathname: string): string {
  for (const item of NAV_ITEMS) {
    if (isItemActive(pathname, item.path) || item.subItems?.some((s) => pathname === s.path.split('#')[0])) {
      return item.group || '';
    }
  }
  return GROUP_ORDER[0];
}

// "3d ago" / "Today" style label from occurred_at (a plain 'YYYY-MM-DD' date, always
// interpreted as a local calendar day so it doesn't shift a day off near midnight UTC).
function relativeDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(`${iso}T00:00:00`).getTime()) / 86400000);
}

// The raw alert description is a single prose sentence built for the full Alerts page
// (e.g. "...with no Win/Loss recorded, $1,150 at risk. AE: RT.") — the trailing "AE: X."
// clause is redundant here since the bell shows AE as its own chip, so strip it for a
// cleaner two-line card instead of one long run-on sentence.
function cleanInsightDescription(desc: string): string {
  return desc.replace(/\s*AE:\s*\S+\.?\s*$/, '').trim();
}

// Each category gets a plain icon for quick scanning — color here is reserved for
// severity/unread state (the app's own convention), not spent on decoration per category.
const INSIGHT_CATEGORY_ICON: Record<string, LucideIcon> = {
  Customer: Building2,
  Pipeline: GitBranch,
  AE: UserCog,
  Operations: Package,
};
const insightIcon = (cat: string) => INSIGHT_CATEGORY_ICON[cat] || Bell;

// Groups the feed into time buckets — a flat 8-row list reading "Today" through "6y ago"
// back to back buries what's actually fresh under what's merely still true.
function bucketLabel(days: number): string {
  if (days <= 0) return 'Today';
  if (days <= 7) return 'This Week';
  if (days <= 30) return 'This Month';
  return 'Earlier';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [bellOpen, setBellOpen] = useState(false);
  const [insightCategory, setInsightCategory] = useState<string | null>(null);
  const { isSuperAdmin, hasRole, user, logout } = useAuth();

  // Header search: a live type-ahead dropdown over the same api.search() UniversalSearch.tsx
  // uses, so results here match the full search page exactly.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const debouncedSearchQuery = useDebounce(searchQuery, 250);
  const { data: searchData, isFetching: isSearchFetching } = useQuery({
    queryKey: ['header-search', debouncedSearchQuery],
    queryFn: () => api.search(debouncedSearchQuery),
    enabled: debouncedSearchQuery.trim().length >= 2,
    staleTime: 30000,
  });
  const searchResults = (searchData?.items ?? []).slice(0, 8);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSelect = (item: SearchResultItem) => {
    setSearchQuery('');
    setSearchOpen(false);
    navigate(`/app${item.url}`);
  };

  const handleViewAllResults = () => {
    setSearchOpen(false);
    navigate(`/app/search?q=${encodeURIComponent(searchQuery)}`);
  };

  const { data: insights } = useQuery({
    queryKey: ['key-insights', insightCategory],
    queryFn: () => api.getKeyInsights(insightCategory ?? undefined),
    refetchInterval: 60000,
  });
  const items = insights?.items.slice(0, 8) ?? [];
  const unreadCount = insights?.unread_count ?? 0;
  const categories = insights?.categories ?? [];

  // Opening the bell no longer marks everything seen -- that let the badge clear just
  // by glancing at it. Seen is now only set on real click-through or "Mark all read".
  const handleBellOpenChange = (open: boolean) => {
    setBellOpen(open);
    if (open && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  };

  const handleMarkAllRead = () => {
    api.markAllInsightsSeen().then(() => {
      queryClient.invalidateQueries({ queryKey: ['key-insights'] });
    });
  };

  const handleInsightClick = (insight: KeyInsight) => {
    api.markInsightsSeen([insight.id]).then(() => {
      queryClient.invalidateQueries({ queryKey: ['key-insights'] });
    });
    if (insight.entity_type === 'company' && insight.entity_id) navigate(`/app/customers/${insight.entity_id}`);
    else if (insight.entity_type === 'pipeline') navigate('/app/pipeline');
    else if (insight.entity_type === 'mawb') navigate('/app/mawb');
    else navigate('/app/alerts');
  };

  const handleDismiss = (e: React.MouseEvent, id: string, days: number | null) => {
    e.stopPropagation();
    api.snoozeInsight(id, days).then(() => {
      queryClient.invalidateQueries({ queryKey: ['key-insights'] });
    });
  };

  // Desktop push for genuinely new unseen high-severity items while a tab is open --
  // no service worker, so this only fires while the tab is open (see plan notes).
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    for (const insight of insights?.items ?? []) {
      if (insight.seen || notifiedRef.current.has(insight.id)) continue;
      notifiedRef.current.add(insight.id);
      new Notification(insight.title, { body: insight.description });
    }
  }, [insights]);

  // Groups start collapsed except whichever one contains the current route — with 6 groups
  // and 20 items, showing everything at once by default was the main source of "hard to
  // navigate": every load, users had to visually scan the whole list to find where they were.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set([activeGroupFor(location.pathname)]));
  useEffect(() => {
    setOpenGroups((prev) => new Set(prev).add(activeGroupFor(location.pathname)));
  }, [location.pathname]);
  const toggleGroup = (name: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const alertsQuery = useQuery({ queryKey: ['alerts'], queryFn: api.getAlerts, refetchInterval: 60000, staleTime: 30000 });
  const highAlertCount = (alertsQuery.data?.alerts || []).filter((a: any) => a.severity === 'high').length;
  const pipelineQuery = useQuery({ queryKey: ['pipeline', 'overdue-summary'], queryFn: () => api.getPipeline({ overdue_only: true }), refetchInterval: 60000, staleTime: 30000 });
  const overdueCount = pipelineQuery.data?.total ?? 0;

  const badgeFor = (path: string): number => {
    if (path === '/app/alerts') return highAlertCount;
    if (path === '/app/pipeline') return overdueCount;
    return 0;
  };

  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || hasRole(item.roles as any));

  const groups = visibleItems.reduce((acc, item) => {
    if (!acc[item.group || "Unknown"]) acc[item.group || "Unknown"] = [];
    acc[item.group || "Unknown"].push(item);
    return acc;
  }, {} as Record<string, typeof NAV_ITEMS>);

  const visibleGroups = GROUP_ORDER.filter((groupName) => {
    if (groupName === 'Data & Integration' || groupName === 'Administration') return isSuperAdmin;
    return true;
  });

  return (
    <div className="flex h-screen w-full bg-zinc-950 font-sans overflow-hidden text-zinc-50">
      {/* Sidebar — collapses to an icon rail (never fully disappears, so navigation is always
          reachable) rather than the old width:0 behavior that hid every link and icon. */}
      <aside
        className={cn(
          "bg-zinc-950 text-zinc-400 flex flex-col justify-between flex-shrink-0 border-r border-zinc-800 z-20 transition-[width] duration-200",
          sidebarOpen ? "w-[240px]" : "w-[64px]"
        )}
      >
        <div className={cn("border-b border-zinc-800 flex items-center justify-center", sidebarOpen ? "px-5 py-4" : "px-2 py-4")}>
          {sidebarOpen ? (
            <img
              src="/shangrila-logo.png"
              alt="Shangrila Tours"
              className="w-full max-w-[180px] h-auto object-contain rounded opacity-90 hover:opacity-100 transition-opacity"
            />
          ) : (
            <img src="/shangrila-logo.png" alt="Shangrila Tours" className="w-9 h-9 object-contain rounded opacity-90" />
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-4 px-3 space-y-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleGroups.map(groupName => {
            const items = groups[groupName];
            if (!items) return null;
            const groupActive = activeGroupFor(location.pathname) === groupName;
            const isOpen = openGroups.has(groupName);

            if (!sidebarOpen) {
              // Icon rail: flat list, no group headers, tooltip carries the label.
              const isLastGroup = groupName === visibleGroups[visibleGroups.length - 1];
              return (
                <div key={groupName} className={cn("space-y-1", !isLastGroup && "mb-2 pb-2 border-b border-zinc-800/50")}>
                  {items.map(item => {
                    const isActive = isItemActive(location.pathname, item.path);
                    const badge = badgeFor(item.path);
                    return (
                      <Tooltip key={item.path} delayDuration={200}>
                        <TooltipTrigger asChild>
                          <Link
                            to={item.path}
                            className={cn(
                              "relative w-full flex items-center justify-center py-2.5 rounded-md transition-colors",
                              isActive ? "text-zinc-50 bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
                            )}
                          >
                            <item.icon size={20} />
                            {badge > 0 && <span className="absolute top-1 right-2.5 w-1.5 h-1.5 rounded-full bg-rose-500" />}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {item.label}
                          {badge > 0 ? (item.path === '/app/alerts' ? ` (${badge} critical)` : ` (${badge} overdue)`) : ''}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              );
            }

            return (
              <Collapsible.Root open={isOpen} onOpenChange={() => toggleGroup(groupName)} key={groupName} className="space-y-1">
                <Collapsible.Trigger className={cn(
                  "flex items-center w-full justify-between text-[10px] font-bold uppercase tracking-widest px-3 py-2 transition-colors",
                  groupActive ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-50"
                )}>
                  <span className="flex items-center gap-1.5">
                    {groupActive && <span className="w-1 h-1 rounded-full bg-emerald-400" />}
                    {groupName}
                  </span>
                  <ChevronDown size={12} className={cn("transition-transform", isOpen && "rotate-180")} />
                </Collapsible.Trigger>
                <Collapsible.Content className="space-y-0.5">
                  {items.map(item => {
                    const isActive = isItemActive(location.pathname, item.path);
                    const badge = badgeFor(item.path);

                    if (item.subItems) {
                      const subOpen = isActive;
                      return (
                        <Collapsible.Root defaultOpen={subOpen} key={item.path} className="space-y-0.5">
                          <Collapsible.Trigger className={cn(
                            "w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] font-medium transition-colors group",
                            isActive ? "text-zinc-50 bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
                          )}>
                            <div className="flex items-center gap-3">
                              <item.icon size={15} className={isActive ? "text-zinc-50" : "text-zinc-500"} />
                              {item.label}
                            </div>
                            <ChevronDown size={12} className="text-zinc-500 group-data-[state=open]:rotate-180 transition-transform" />
                          </Collapsible.Trigger>
                          <Collapsible.Content className="pl-9 space-y-0.5 py-1">
                            {item.subItems.map(subItem => (
                              <Link
                                key={subItem.path}
                                to={subItem.path}
                                className={cn(
                                  "w-full flex items-center gap-2 py-1.5 px-2 rounded-md text-[12px] font-medium transition-colors",
                                  location.pathname + location.hash === subItem.path
                                    ? "text-emerald-400 bg-zinc-900"
                                    : "text-zinc-500 hover:text-zinc-200"
                                )}
                              >
                                {subItem.icon && <subItem.icon size={13} className="shrink-0" />}
                                {subItem.label}
                              </Link>
                            ))}
                          </Collapsible.Content>
                        </Collapsible.Root>
                      );
                    }

                    return (
                      <Link
                        key={item.path}
                        to={item.path}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors",
                          isActive ? "text-zinc-50 bg-zinc-800" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
                        )}
                      >
                        <item.icon size={15} className={isActive ? "text-zinc-50" : "text-zinc-500"} />
                        <span className="flex-1">{item.label}</span>
                        {badge > 0 && (
                          <span
                            title={item.path === '/app/alerts' ? `${badge} critical-severity alert${badge === 1 ? '' : 's'}` : `${badge} overdue`}
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400"
                          >
                            {badge}{item.path === '/app/alerts' ? ' crit' : ''}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </Collapsible.Content>
              </Collapsible.Root>
            );
          })}
        </div>

        <div className={cn("border-t border-zinc-800 bg-zinc-950", sidebarOpen ? "px-4 py-3" : "px-2 py-3")}>
          {sidebarOpen ? (
            <div className="flex items-center gap-2 text-[11px] font-semibold text-zinc-400">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              All systems operational
            </div>
          ) : (
            <div className="flex justify-center"><div className="w-2 h-2 rounded-full bg-emerald-400" /></div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* TopHeader */}
        <header className="h-14 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between px-5 flex-shrink-0 z-30 sticky top-0">
          <div className="flex items-center gap-4">
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  aria-label={sidebarOpen ? "Collapse navigation" : "Expand navigation"}
                  className="p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50 rounded-md transition-colors"
                >
                  {sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}</TooltipContent>
            </Tooltip>

            <div ref={searchContainerRef} className="relative group w-56 hidden lg:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={15} />
              <input
                type="text"
                placeholder="Search ICRIS, AWB, MAWB…"
                aria-label="Search Customer 360"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false); e.currentTarget.blur(); }
                  else if (e.key === 'Enter' && searchQuery.trim().length >= 2) handleViewAllResults();
                }}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-md py-1.5 pl-9 pr-3 text-sm text-zinc-50 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-50/30 focus:border-zinc-50 transition-colors"
              />

              {searchOpen && searchQuery.trim().length >= 2 && (
                <div className="absolute left-0 top-full mt-1.5 w-96 bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl overflow-hidden z-50">
                  {isSearchFetching && searchResults.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-zinc-500">Searching…</div>
                  ) : searchResults.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-zinc-500">No matches for "{searchQuery}"</div>
                  ) : (
                    <div className="max-h-96 overflow-y-auto py-1">
                      {searchResults.map((item) => {
                        const Icon = SEARCH_RESULT_ICONS[item.result_type] || Building2;
                        return (
                          <button
                            key={item.url}
                            onClick={() => handleSearchSelect(item)}
                            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-zinc-800 transition-colors"
                          >
                            <Icon size={15} className="text-zinc-500 mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-zinc-50 truncate">{item.title}</p>
                              <p className="text-[11px] text-zinc-500 truncate">{item.subtitle}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <button
                    onClick={handleViewAllResults}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-zinc-300 bg-zinc-950 border-t border-zinc-800 hover:bg-zinc-800 transition-colors"
                  >
                    View all results for "{searchQuery}" <ArrowRight size={12} />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <DropdownMenu.Root open={bellOpen} onOpenChange={handleBellOpenChange}>
              <DropdownMenu.Trigger asChild>
                <button
                  aria-label="Key insights"
                  className="relative p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50 rounded-md transition-colors focus:outline-none"
                >
                  <Bell size={18} />
                  {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-[3px] rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={8}
                  className="z-50 w-[380px] max-h-[480px] flex flex-col overflow-hidden bg-zinc-900 border border-zinc-800 rounded-md shadow-md animate-in fade-in zoom-in-95"
                >
                  {/* Header */}
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 shrink-0">
                    <span className="text-xs font-bold text-zinc-200">Key Insights</span>
                    {unreadCount > 0 ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleMarkAllRead(); }}
                        className="text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        Mark all read
                      </button>
                    ) : (
                      <span className="text-[11px] text-zinc-500">All caught up</span>
                    )}
                  </div>

                  {/* Category filter */}
                  {categories.length > 1 && (
                    <div className="flex items-center gap-4 px-3 border-b border-zinc-800 shrink-0">
                      {[null, ...categories].map((cat) => {
                        const active = insightCategory === cat;
                        return (
                          <button
                            key={cat ?? 'all'}
                            onClick={(e) => { e.stopPropagation(); setInsightCategory(cat); }}
                            className={cn(
                              "py-2 text-[11px] font-semibold border-b-2 -mb-px transition-colors",
                              active ? "text-zinc-100 border-zinc-100" : "text-zinc-500 border-transparent hover:text-zinc-300"
                            )}
                          >
                            {cat ?? 'All'}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Feed */}
                  <div className="overflow-y-auto flex-1">
                    {items.length === 0 ? (
                      <div className="px-3 py-10 text-center">
                        <p className="text-xs font-semibold text-zinc-300">Nothing needs your attention</p>
                        <p className="text-[11px] text-zinc-500 mt-1">New high-priority items will show up here.</p>
                      </div>
                    ) : (
                      (() => {
                        // Group into time buckets — a flat 8-row list mixing "today" with
                        // "6 years ago" buries what's actually fresh under what's merely still true.
                        const buckets: { label: string; rows: typeof items }[] = [];
                        for (const insight of items) {
                          const label = bucketLabel(daysAgo(insight.occurred_at));
                          const bucket = buckets.find((b) => b.label === label);
                          if (bucket) bucket.rows.push(insight);
                          else buckets.push({ label, rows: [insight] });
                        }
                        return buckets.map((bucket) => (
                          <div key={bucket.label}>
                            <div className="px-3 pt-2 pb-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                              {bucket.label}
                            </div>
                            {bucket.rows.map((insight) => {
                              const Icon = insightIcon(insight.category);
                              return (
                                <DropdownMenu.Item
                                  key={insight.id}
                                  onClick={() => handleInsightClick(insight)}
                                  className={cn(
                                    "group flex items-start gap-2.5 px-3 py-2.5 cursor-pointer outline-none hover:bg-zinc-800 transition-colors border-l-2",
                                    insight.seen ? "border-transparent" : "border-rose-500"
                                  )}
                                >
                                  <Icon size={13} className="text-zinc-500 mt-0.5 shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-2">
                                      <p className="text-xs font-semibold text-zinc-100 leading-snug truncate">{insight.title}</p>
                                      <span className="text-[10px] text-zinc-500 shrink-0 mt-0.5">{relativeDate(insight.occurred_at)}</span>
                                    </div>
                                    <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2 leading-relaxed">{cleanInsightDescription(insight.description)}</p>
                                    <div className="flex items-center gap-1.5 mt-1.5">
                                      <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">{insight.category}</span>
                                      {insight.ae_code && (
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">AE {insight.ae_code}</span>
                                      )}
                                    </div>
                                  </div>
                                  <button
                                    onClick={(e) => handleDismiss(e, insight.id, null)}
                                    title="Dismiss"
                                    className="shrink-0 p-0.5 rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-200 hover:bg-zinc-700 transition-opacity"
                                  >
                                    <X size={12} />
                                  </button>
                                </DropdownMenu.Item>
                              );
                            })}
                          </div>
                        ));
                      })()
                    )}
                  </div>

                  {/* Footer */}
                  <DropdownMenu.Item
                    onClick={() => navigate('/app/alerts')}
                    className="px-3 py-2.5 text-center text-xs font-semibold text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer outline-none border-t border-zinc-800 shrink-0 transition-colors"
                  >
                    View all in Alerts
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex items-center gap-1.5 text-xs text-zinc-400 font-medium hidden md:flex hover:text-zinc-200 transition-colors focus:outline-none">
                  <ShieldCheck size={14} className="text-emerald-400" />
                  <span>{user?.display_name ?? 'Operational'}</span>
                  <ChevronDown size={14} className="opacity-50" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  className="z-50 min-w-[160px] bg-zinc-900 border border-zinc-800 rounded-md p-1 shadow-md animate-in fade-in zoom-in-95"
                >
                  <DropdownMenu.Item
                    onClick={() => logout()}
                    className="flex items-center gap-2 px-2 py-1.5 text-sm text-rose-400 hover:bg-zinc-800 hover:text-rose-300 rounded-sm cursor-pointer outline-none transition-colors"
                  >
                    <LogOut size={14} />
                    Logout
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Separator.Root decorative orientation="vertical" className="w-[1px] h-6 bg-zinc-800" />
            <span className="text-xs font-medium text-zinc-500">Customer 360</span>
          </div>
        </header>

        {children}
      </main>
    </div>
  );
}
