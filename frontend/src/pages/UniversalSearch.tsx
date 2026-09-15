import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { SearchResultItem } from '../api';
import { useNavigate } from 'react-router-dom';
import {
  Search, Building2, Package, FileText,
  Plane, ArrowRight, X, Clock,
  Globe, ShieldAlert, Command, ChevronDown, ChevronRight
} from 'lucide-react';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

const FILTER_CHIPS = [
  { id: 'all', label: 'Everything' },
  { id: 'company', label: 'Customers' },
  { id: 'mawb', label: 'AWBs' },
  { id: 'shipment', label: 'Shipments' },
  { id: 'crm', label: 'CRM Records' },
  { id: 'document', label: 'Documents' },
  { id: 'analytics', label: 'Analytics' },
];

const PRESET_RECENTS = ['World Connection', 'AWB1928', 'Germany', 'Manifest', 'Revenue Report'];

function fmt$(v: number) { return `$${v.toLocaleString()}`; }

export default function UniversalSearch() {
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);
  const [activeFilter, setActiveFilter] = useState('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  
  useEffect(() => {
    const saved = localStorage.getItem('c360_recent_searches');
    if (saved) {
      setRecentSearches(JSON.parse(saved));
    } else {
      setRecentSearches(PRESET_RECENTS);
    }
  }, []);

  const saveRecentSearch = (q: string) => {
    if (!q.trim()) return;
    const updated = [q, ...recentSearches.filter(s => s.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    setRecentSearches(updated);
    localStorage.setItem('c360_recent_searches', JSON.stringify(updated));
  };

  const removeRecentSearch = (q: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = recentSearches.filter(s => s !== q);
    setRecentSearches(updated);
    localStorage.setItem('c360_recent_searches', JSON.stringify(updated));
  };

  const clearAllRecents = () => {
    setRecentSearches([]);
    localStorage.removeItem('c360_recent_searches');
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => api.search(debouncedQuery),
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 30000,
  });

  const rawItems = data?.items || [];
  
  const filteredItems = useMemo(() => {
    if (activeFilter === 'all') return rawItems;
    if (activeFilter === 'analytics') return rawItems.filter(i => i.result_type === 'company' || i.result_type === 'mawb');
    return rawItems.filter(i => i.result_type === activeFilter);
  }, [rawItems, activeFilter]);

  const groups = useMemo(() => {
    const g: Record<string, { label: string; icon: any; items: SearchResultItem[] }> = {
      company: { label: 'Customers & Companies', icon: Building2, items: [] },
      mawb: { label: 'Air Waybills (MAWBs)', icon: Plane, items: [] },
      shipment: { label: 'Shipments', icon: Package, items: [] },
      document: { label: 'Documents', icon: FileText, items: [] },
    };

    filteredItems.forEach(item => {
      const type = item.result_type;
      if (g[type]) {
        g[type].items.push(item);
      } else {
        if (!g['company']) g['company'] = { label: 'Customers & Companies', icon: Building2, items: [] };
        g['company'].items.push(item);
      }
    });

    return g;
  }, [filteredItems]);

  const flatNavigableResults = useMemo(() => {
    const flat: SearchResultItem[] = [];
    Object.keys(groups).forEach(typeKey => {
      if (!collapsedGroups[typeKey]) {
        flat.push(...groups[typeKey].items);
      }
    });
    return flat;
  }, [groups, collapsedGroups]);

  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => { 
    setSelectedIndex(0); 
  }, [debouncedQuery, activeFilter]);

  // Keyboard navigation listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === 'Escape') {
        if (query) {
          setQuery('');
        } else {
          searchInputRef.current?.blur();
        }
        return;
      }

      if (!debouncedQuery || flatNavigableResults.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < flatNavigableResults.length - 1 ? prev + 1 : prev));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = flatNavigableResults[selectedIndex];
        if (selected) {
          saveRecentSearch(debouncedQuery);
          navigate(`/app${selected.url}`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [flatNavigableResults, selectedIndex, debouncedQuery, query, navigate]);

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelectResult = (item: SearchResultItem) => {
    saveRecentSearch(debouncedQuery);
    navigate(`/app${item.url}`);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background min-h-full">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        
        {/* PAGE TITLE */}
        <div className="text-center max-w-xl mx-auto space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900">
            Universal Search
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 font-medium">
            Find customers, shipments, AWBs, companies, CRM records, and documents instantly.
          </p>
        </div>

        {/* HERO SEARCH BAR */}
        <div className="max-w-3xl mx-auto">
          <div className="relative bg-white rounded-[20px] border border-[#E2E8F0] shadow-[0_4px_24px_rgba(15,23,42,0.06)] flex items-center p-2.5 transition-all focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
            <Search className="ml-3 text-primary shrink-0" size={22} />
            <input 
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customers, AWBs, ICRIS, CRM records..."
              className="w-full h-11 px-3 bg-transparent text-sm sm:text-base font-semibold text-slate-900 placeholder:text-slate-400 outline-none"
              autoFocus
            />
            {query ? (
              <button 
                onClick={() => setQuery('')}
                className="p-1.5 mr-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
                title="Clear search (Esc)"
              >
                <X size={18} />
              </button>
            ) : (
              <div className="mr-3 flex items-center gap-1 px-2 py-1 bg-slate-100 border border-slate-200 rounded-md text-[11px] font-bold text-slate-500 select-none">
                <Command size={12} />
                <span>K</span>
              </div>
            )}
          </div>

          {/* QUICK FILTER CHIPS */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {FILTER_CHIPS.map(chip => {
              const isActive = activeFilter === chip.id;
              return (
                <button
                  key={chip.id}
                  onClick={() => setActiveFilter(chip.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                    isActive 
                      ? 'bg-primary text-white shadow-xs' 
                      : 'bg-white border border-[#E2E8F0] text-slate-600 hover:bg-slate-50 hover:border-slate-300'
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* DEFAULT VIEW (WHEN NO QUERY TYPED) */}
        {!debouncedQuery.trim() && (
          <div className="max-w-4xl mx-auto space-y-6 pt-4">
            
            {/* RECENT SEARCHES */}
            {recentSearches.length > 0 && (
              <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-5 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_30px_rgba(15,23,42,0.06)]">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-900 tracking-tight">
                    <Clock size={15} className="text-slate-400" />
                    <span>Recent Searches</span>
                  </div>
                  <button 
                    onClick={clearAllRecents}
                    className="text-[11px] font-semibold text-rose-500 hover:text-rose-700 transition-colors"
                  >
                    Clear History
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {recentSearches.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => setQuery(s)}
                      className="group inline-flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 hover:border-primary/40 hover:bg-blue-50/50 rounded-lg text-xs font-semibold text-slate-700 hover:text-primary transition-all"
                    >
                      <span>{s}</span>
                      <X 
                        size={12} 
                        onClick={(e) => removeRecentSearch(s, e)}
                        className="text-slate-400 hover:text-rose-600 transition-colors" 
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}

        {/* SEARCH RESULTS SECTION */}
        {debouncedQuery.trim().length > 0 && (
          <div className="max-w-4xl mx-auto space-y-6 pt-2">
            
            {/* LOADING STATE */}
            {isLoading && (
              <div className="space-y-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="bg-white rounded-[16px] border border-[#E2E8F0] p-5 animate-pulse space-y-3">
                    <div className="h-4 bg-slate-200 rounded w-1/3" />
                    <div className="h-3 bg-slate-100 rounded w-2/3" />
                  </div>
                ))}
              </div>
            )}

            {/* ERROR STATE */}
            {isError && (
              <div className="bg-white rounded-[16px] border border-rose-200 p-6 text-center space-y-3 shadow-xs">
                <ShieldAlert size={32} className="mx-auto text-rose-500" />
                <p className="text-sm font-bold text-slate-900">Unable to perform search</p>
                <p className="text-xs text-slate-500">Check your network or server connection.</p>
                <button 
                  onClick={() => refetch()}
                  className="px-4 py-2 bg-rose-50 text-rose-700 font-bold text-xs rounded-lg hover:bg-rose-100 transition-colors"
                >
                  Retry Search
                </button>
              </div>
            )}

            {/* NO RESULTS STATE */}
            {!isLoading && !isError && filteredItems.length === 0 && (
              <div className="bg-white rounded-[16px] border border-[#E2E8F0] p-10 text-center space-y-4 shadow-sm">
                <Search size={36} className="mx-auto text-slate-300" />
                <div>
                  <h3 className="text-base font-bold text-slate-900">No matching records found</h3>
                  <p className="text-xs text-slate-500 mt-1">We couldn't find anything matching "{debouncedQuery}"</p>
                </div>

                <div className="pt-2 border-t border-slate-100 max-w-sm mx-auto">
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Try searching by:</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {['Customer Name', 'AWB Number', 'ICRIS ID', 'Destination', 'Document Name'].map((t, idx) => (
                      <span key={idx} className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-md text-[11px] font-medium">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* GROUPED RESULTS */}
            {!isLoading && !isError && filteredItems.length > 0 && (
              <div className="space-y-6">
                {Object.keys(groups).map((typeKey) => {
                  const group = groups[typeKey];
                  if (group.items.length === 0) return null;

                  const isCollapsed = collapsedGroups[typeKey];
                  const GroupIcon = group.icon;

                  return (
                    <div key={typeKey} className="space-y-3">
                      {/* GROUP HEADER */}
                      <button 
                        onClick={() => toggleGroupCollapse(typeKey)}
                        className="w-full flex items-center justify-between py-1 text-xs font-bold text-slate-700 hover:text-primary transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <GroupIcon size={16} className="text-primary" />
                          <span className="text-sm font-bold text-slate-900">{group.label}</span>
                          <span className="px-2 py-0.5 bg-blue-50 text-primary text-[11px] font-extrabold rounded-full">
                            {group.items.length}
                          </span>
                        </div>
                        {isCollapsed ? <ChevronRight size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                      </button>

                      {/* GROUP ITEMS */}
                      {!isCollapsed && (
                        <div className="space-y-3">
                          {group.items.map((item) => {
                            const globalIndex = flatNavigableResults.findIndex(x => x === item);
                            const isSelected = globalIndex === selectedIndex;
                            const m = item.metadata || {};

                            return (
                              <div
                                key={item.url}
                                onClick={() => handleSelectResult(item)}
                                className={`bg-white rounded-[16px] border p-4 sm:p-5 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_30px_rgba(15,23,42,0.06)] transition-all cursor-pointer ${
                                  isSelected 
                                    ? 'border-primary ring-2 ring-primary/20 bg-blue-50/10' 
                                    : 'border-[#E2E8F0] hover:border-primary/50'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-4">
                                  
                                  <div className="flex items-start gap-3.5 min-w-0">
                                    <div className="p-2.5 bg-blue-50 text-primary rounded-xl shrink-0 mt-0.5">
                                      <GroupIcon size={20} />
                                    </div>

                                    <div className="min-w-0">
                                      {/* Title & Subtitle */}
                                      <div className="flex items-center gap-2 flex-wrap mb-1">
                                        <h3 className="text-sm font-bold text-slate-900 group-hover:text-primary transition-colors truncate">
                                          {item.title}
                                        </h3>
                                        <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded uppercase tracking-wider">
                                          {item.result_type}
                                        </span>
                                      </div>

                                      <p className="text-xs text-slate-500 font-medium line-clamp-1 mb-3">
                                        {item.subtitle}
                                      </p>

                                      {/* Rich Metadata Pills */}
                                      <div className="flex flex-wrap items-center gap-2 text-xs">
                                        {m.icris_number && (
                                          <span className="px-2 py-0.5 bg-slate-100 font-mono font-bold text-slate-700 rounded text-[11px]">
                                            ICRIS: {m.icris_number}
                                          </span>
                                        )}

                                        {m.revenue !== undefined && m.revenue !== null && (
                                          <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 font-bold rounded text-[11px]">
                                            Revenue: {fmt$(m.revenue)}
                                          </span>
                                        )}

                                        {m.shipments !== undefined && (
                                          <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 font-bold rounded text-[11px]">
                                            {m.shipments} Shipments
                                          </span>
                                        )}

                                        {m.country && (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-700 font-medium rounded text-[11px]">
                                            <Globe size={11} /> {m.country}
                                          </span>
                                        )}

                                        {m.status && (
                                          <span className="px-2 py-0.5 bg-sky-50 text-sky-700 font-bold rounded text-[11px] capitalize">
                                            {m.status}
                                          </span>
                                        )}

                                        {m.date && (
                                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 font-medium rounded text-[11px]">
                                            {m.date}
                                          </span>
                                        )}

                                        {m.weight && (
                                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 font-medium rounded text-[11px]">
                                            {m.weight} kg
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  <div className="shrink-0 flex items-center gap-1 text-xs font-bold text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                                    <span>Open</span>
                                    <ArrowRight size={14} />
                                  </div>

                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  );
}
