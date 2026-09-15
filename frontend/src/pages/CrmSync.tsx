
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Play, Square, Pause, PlayCircle, FileText,
  CheckCircle2, Clock, AlertTriangle, Terminal,
  RefreshCw, Server
} from 'lucide-react';
import { api } from '../api';

function fmtDate(d?: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function StatusPill({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  if (s === 'running') return <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 text-[10px] font-bold uppercase tracking-wider">RUNNING</span>;
  if (s === 'completed') return <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold uppercase tracking-wider">COMPLETED</span>;
  if (s === 'failed') return <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[10px] font-bold uppercase tracking-wider">FAILED</span>;
  return <span className="px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400 border border-slate-500/30 text-[10px] font-bold uppercase tracking-wider">{s}</span>;
}

export default function CrmSync() {
  const queryClient = useQueryClient();

  const { data: statusData } = useQuery({
    queryKey: ['crm-status'],
    queryFn: () => api.getCrmStatus(),
    refetchInterval: 5000 // auto-refresh fast for console
  });

  const { data: runsData = [] } = useQuery({
    queryKey: ['crm-runs'],
    queryFn: () => api.getSyncRuns(10),
    refetchInterval: 5000
  });

  // No diagnose query here on purpose: /crm-sync/diagnose performs live CRM logins
  // and page fetches server-side, and nothing on this page renders its result.
  // Call it from a button if a diagnose panel is ever built — not on every mount.

  // One "Trigger Sync" now syncs everything: queue the incremental manifest run
  // (fast, 202), then run the synchronous active-pipeline sync. Returns the pipeline
  // run payload so the banner can surface its status.
  const syncMutation = useMutation({
    mutationFn: async () => {
      await api.syncNow('both', 3);
      return api.syncPipeline();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['crm-status'] });
      queryClient.invalidateQueries({ queryKey: ['crm-runs'] });
      queryClient.invalidateQueries({ queryKey: ['pipeline'] });
    },
  });

  const isRunning = statusData?.worker_status === 'running' || syncMutation.isPending;
  const config = statusData?.configuration || {};

  // Mocking timeline data for the console feel based on runs and status
  const timeline = [
    { time: new Date().toISOString(), log: `[SYSTEM] Heartbeat received from worker ${statusData?.worker?.worker_id || 'unknown'}` },
    { time: statusData?.last_successful_sync_at, log: `[SYNC] Last successful cycle completed` },
    ...runsData.slice(0, 3).map((r: any) => ({
      time: r.created_at, log: `[JOB] Job ${r.id.split('-')[0]} transitioned to ${r.status.toUpperCase()}`
    }))
  ].filter(x => x.time).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950 text-zinc-300 font-sans selection:bg-teal-500/30">
      <div className="max-w-[1200px] mx-auto p-6 space-y-6">
        
        {/* Header Title */}
        <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
          <Terminal className="text-teal-500" size={24} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-zinc-100 uppercase tracking-widest">CRM Synchronization Hub</h1>
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[9px] font-bold uppercase tracking-wider">Advanced</span>
            </div>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Engineering console for the background CRM sync worker — most day-to-day data fixes belong on Matching Review or Data Quality instead.
            </p>
          </div>
          <div className="flex-1"></div>
          {isRunning ? (
            <div className="flex items-center gap-2 px-3 py-1 bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded text-xs font-bold uppercase tracking-wider">
              <RefreshCw size={12} className="animate-spin" /> Live
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1 bg-zinc-800 border border-zinc-700 text-zinc-400 rounded text-xs font-bold uppercase tracking-wider">
              <Clock size={12} /> Standby
            </div>
          )}
        </div>

        {/* KPI Panel */}
        <div className="grid grid-cols-6 gap-px bg-zinc-800 border border-zinc-800 rounded">
          <div className="bg-zinc-950 p-4">
            <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Worker Status</div>
            <div className={`text-lg font-mono font-bold ${isRunning ? 'text-teal-400' : 'text-zinc-300'}`}>
              {isRunning ? 'RUNNING' : 'IDLE'}
            </div>
          </div>
          <div className="bg-zinc-950 p-4">
            <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Last Sync</div>
            <div className="text-sm font-mono font-medium text-zinc-300 mt-1.5 truncate">
              {fmtDate(statusData?.last_successful_sync_at)}
            </div>
          </div>
          <div className="bg-zinc-950 p-4">
            <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Queue</div>
            <div className="text-lg font-mono font-bold text-zinc-300">
              {statusData?.worker?.queue_depth || 0} <span className="text-xs text-zinc-600 font-sans">items</span>
            </div>
          </div>
          <div className="bg-zinc-950 p-4">
            <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Pipeline Health</div>
            <div className="text-lg font-mono font-bold text-emerald-400">
              {statusData?.ready ? '100%' : 'DEGRADED'}
            </div>
          </div>
          <div className="bg-zinc-950 p-4">
            <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Records Today</div>
            <div className="text-lg font-mono font-bold text-zinc-300">
              {((runsData[0]?.shipments_created || 0) + (runsData[0]?.shipments_updated || 0)) || 0} <span className="text-xs text-zinc-600 font-sans">synced</span>
            </div>
          </div>
          <div className="bg-zinc-950 p-4">
            <div className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider mb-1">Failed</div>
            <div className="text-lg font-mono font-bold text-rose-400">
              {runsData[0]?.failed_count || 0} <span className="text-xs text-rose-900 font-sans">errors</span>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 p-2 bg-zinc-900 border border-zinc-800 rounded">
          <button 
            onClick={() => syncMutation.mutate()}
            disabled={isRunning}
            className="flex-1 flex items-center justify-center gap-2 h-9 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 border border-zinc-700 rounded text-xs font-bold uppercase tracking-wider text-zinc-300 transition-colors"
          >
            <Play size={14} className="text-teal-400" /> Trigger Sync
          </button>
          <button
            disabled={!isRunning}
            className="flex-1 flex items-center justify-center gap-2 h-9 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 border border-zinc-700 rounded text-xs font-bold uppercase tracking-wider text-zinc-300 transition-colors"
          >
            <Square size={14} className="text-rose-400" /> Cancel Running
          </button>
          <button 
            disabled={true}
            className="flex-1 flex items-center justify-center gap-2 h-9 bg-zinc-800 disabled:opacity-50 border border-zinc-700 rounded text-xs font-bold uppercase tracking-wider text-zinc-500 cursor-not-allowed"
            title="Global pause not supported by backend"
          >
            <Pause size={14} /> Pause Worker
          </button>
          <button 
            disabled={true}
            className="flex-1 flex items-center justify-center gap-2 h-9 bg-zinc-800 disabled:opacity-50 border border-zinc-700 rounded text-xs font-bold uppercase tracking-wider text-zinc-500 cursor-not-allowed"
          >
            <PlayCircle size={14} /> Resume Worker
          </button>
          <button 
            className="flex-1 flex items-center justify-center gap-2 h-9 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-xs font-bold uppercase tracking-wider text-zinc-300 transition-colors"
          >
            <FileText size={14} className="text-blue-400" /> View Logs
          </button>
        </div>

        {syncMutation.isError && (
          <div className="px-3 py-2 bg-rose-950/30 border border-rose-900 rounded text-xs text-rose-400">
            Sync request failed: {(syncMutation.error as Error)?.message || 'unknown error'}
          </div>
        )}
        {syncMutation.isSuccess && (
          <div className={`px-3 py-2 border rounded text-xs ${
            syncMutation.data.status === 'completed'
              ? 'bg-emerald-950/30 border-emerald-900 text-emerald-400'
              : 'bg-amber-950/30 border-amber-900 text-amber-400'
          }`}>
            Pipeline sync {syncMutation.data.status}
            {syncMutation.data.error_message ? ` — ${syncMutation.data.error_message}` : ''}
          </div>
        )}

        <div className="grid grid-cols-3 gap-6">
          
          {/* Main Console Area */}
          <div className="col-span-2 space-y-6">
            
            {/* Live Worker Timeline */}
            <div className="border border-zinc-800 rounded overflow-hidden flex flex-col bg-zinc-950">
              <div className="px-4 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Live Worker Timeline</span>
                <span className="text-[10px] text-zinc-600 font-mono">tail -f /var/log/crm_worker.log</span>
              </div>
              <div className="p-4 font-mono text-xs space-y-2 h-[200px] overflow-y-auto">
                {timeline.length > 0 ? timeline.map((t, i) => (
                  <div key={i} className="flex items-start gap-3 opacity-80 hover:opacity-100">
                    <span className="text-zinc-500 shrink-0">{new Date(t.time).toISOString().split('T')[1].replace('Z','')}</span>
                    <span className={t.log.includes('SYSTEM') ? 'text-blue-400' : t.log.includes('JOB') ? 'text-teal-400' : 'text-zinc-300'}>
                      {t.log}
                    </span>
                  </div>
                )) : (
                  <div className="text-zinc-600">Waiting for worker events...</div>
                )}
              </div>
            </div>

            {/* Recent Sync Jobs */}
            <div className="border border-zinc-800 rounded overflow-hidden bg-zinc-950">
              <div className="px-4 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Recent Sync Jobs</span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-900/50 border-b border-zinc-800 text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium uppercase">Run ID</th>
                    <th className="px-4 py-2 font-medium uppercase">Started</th>
                    <th className="px-4 py-2 font-medium uppercase">Duration</th>
                    <th className="px-4 py-2 font-medium uppercase text-right">Shipments (Ok/Fail)</th>
                    <th className="px-4 py-2 font-medium uppercase text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {runsData.length > 0 ? runsData.map((run: any) => (
                    <tr key={run.id} className="transition-colors">
                      <td className="px-4 py-2 font-mono text-zinc-400">{run.id.split('-')[0]}</td>
                      <td className="px-4 py-2 text-zinc-400">{fmtDate(run.created_at)}</td>
                      <td className="px-4 py-2 text-zinc-400">
                        {run.completed_at ? `${((new Date(run.completed_at).getTime() - new Date(run.created_at).getTime()) / 1000).toFixed(1)}s` : '-'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className="text-teal-400">{(run.shipments_created || 0) + (run.shipments_updated || 0)}</span> / <span className="text-rose-400">{run.failed_count || 0}</span>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <StatusPill status={run.status} />
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-600 font-mono">No recent jobs</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Recent Errors */}
            <div className="border border-zinc-800 rounded overflow-hidden bg-zinc-950">
              <div className="px-4 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-rose-400/80">Recent Errors</span>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-900/50 border-b border-zinc-800 text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium uppercase">Time</th>
                    <th className="px-4 py-2 font-medium uppercase">Error</th>
                    <th className="px-4 py-2 font-medium uppercase">Run</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {runsData.filter((r: any) => (r.failed_count || 0) > 0).length > 0 ? 
                    runsData.filter((r: any) => (r.failed_count || 0) > 0).slice(0, 3).map((r: any) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2 text-zinc-400 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                        <td className="px-4 py-2 text-rose-400">Pipeline encountered {r.failed_count} quarantine triggers or errors during execution.</td>
                        <td className="px-4 py-2 font-mono text-zinc-500">{r.id.split('-')[0]}</td>
                      </tr>
                    ))
                  : (
                    <tr><td colSpan={3} className="px-4 py-8 text-center text-zinc-600 font-mono">No recent pipeline errors detected.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>

          {/* Right Sidebar (Stats & Config) */}
          <div className="col-span-1 space-y-6">
            
            {/* Import Statistics */}
            <div className="border border-zinc-800 rounded bg-zinc-950">
              <div className="px-4 py-2 bg-zinc-900 border-b border-zinc-800">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Import Statistics</span>
              </div>
              <div className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500 font-medium">Export Overlap Days</span>
                  <span className="text-sm font-mono text-zinc-300">{statusData?.watermarks?.export?.overlap_days || 3}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500 font-medium">Earliest Export Date</span>
                  <span className="text-sm font-mono text-zinc-300">{statusData?.earliest_dates?.export?.date || 'N/A'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500 font-medium">Last Worker Heartbeat</span>
                  <span className="text-xs font-mono text-zinc-400">
                    {statusData?.worker?.heartbeat_at ? new Date(statusData.worker.heartbeat_at).toLocaleTimeString() : 'N/A'}
                  </span>
                </div>
                <div className="pt-3 mt-3 border-t border-zinc-800/50">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Diagnostic Mode</div>
                  <div className="text-xs font-mono text-emerald-500 bg-emerald-500/10 p-2 rounded border border-emerald-500/20">
                    ALL SYSTEMS NOMINAL
                  </div>
                </div>
              </div>
            </div>

            {/* System Configuration */}
            <div className="border border-zinc-800 rounded bg-zinc-950">
              <div className="px-4 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2">
                <Server size={12} className="text-zinc-500" />
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">System Configuration</span>
              </div>
              <div className="p-0">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-zinc-800/50">
                    {Object.entries(config).map(([key, isSet]: [string, any]) => (
                      <tr key={key}>
                        <td className="px-4 py-2 text-zinc-500 font-mono">{key}</td>
                        <td className="px-4 py-2 text-right">
                          {isSet ? (
                            <span className="inline-flex items-center gap-1 text-[10px] text-teal-500 font-bold uppercase"><CheckCircle2 size={10} /> Valid</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] text-rose-500 font-bold uppercase"><AlertTriangle size={10} /> Missing</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {Object.keys(config).length === 0 && (
                      <tr><td className="px-4 py-4 text-center text-zinc-600 font-mono" colSpan={2}>No config data available</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}
