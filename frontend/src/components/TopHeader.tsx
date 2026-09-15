
import { Search, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function TopHeader() {
  const navigate = useNavigate();

  return (
    <header className="h-11 bg-blue-800 border-b border-blue-900/40 flex items-center justify-between px-5 flex-shrink-0 z-10 sticky top-0">
      {/* Brand */}
      <div className="flex items-center gap-2.5">
        <div className="w-5 h-5 bg-orange-500 rounded-sm flex items-center justify-center shrink-0">
          <div className="w-3 h-3 flex flex-col justify-between">
            <div className="w-full h-[1.5px] bg-white/70" />
            <div className="w-full h-[1.5px] bg-white/70" />
            <div className="w-full h-[1.5px] bg-white/70" />
          </div>
        </div>
        <span className="text-white font-bold text-sm tracking-tight leading-none">Shangrila Intelligence</span>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-md mx-6">
        <div className="relative group" onClick={() => navigate('/search')}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-blue-300/70" size={14} />
          <input
            type="text"
            placeholder="Search customers, AWBs, ICRIS…"
            readOnly
            onClick={() => navigate('/search')}
            className="w-full bg-white/5 border border-blue-700/40 rounded-md py-1.5 pl-8 pr-10 text-xs text-white placeholder:text-blue-300/40 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer hover:bg-white/10 transition-all"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
            <kbd className="px-1 py-0.5 bg-white/10 border border-white/10 rounded text-[10px] text-blue-300/60 font-mono">⌘K</kbd>
          </div>
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 text-xs text-blue-300/60 font-medium">
          <ShieldCheck size={13} className="text-blue-400/60" />
          <span className="text-blue-200/80 font-semibold">Administrator</span>
        </div>
        <div className="flex items-center gap-1.5 bg-blue-700/60 hover:bg-blue-700 text-white px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition-colors">
          <div className="w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center text-[10px] font-bold">S</div>
          <span className="hidden sm:inline">Sys Admin</span>
        </div>
      </div>
    </header>
  );
}
