import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  BarChart3, Search, Users, Package, FileText, Database,
  ShieldCheck, Globe
} from 'lucide-react';

const NavItem = ({ to, icon: Icon, label }: { to: string; icon: any; label: string }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all border-l-2 ${isActive
        ? 'text-white bg-blue-700/70 border-l-amber-400'
        : 'text-blue-100 hover:bg-blue-700/40 hover:text-white border-l-transparent'
      }`
    }
  >
    {({ isActive }) => (
      <>
        <Icon size={13} className={isActive ? 'text-amber-400' : 'opacity-50'} />
        {label}
      </>
    )}
  </NavLink>
);

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[9px] font-bold text-blue-300/70 uppercase tracking-widest mb-1.5 px-3 pt-2">
    {children}
  </div>
);

export default function Sidebar() {
  return (
    <aside className="w-[220px] bg-blue-800 text-slate-300 flex flex-col justify-between flex-shrink-0 shadow-lg z-20">
      {/* Logo */}
      <div className="px-4 py-3.5 border-b border-blue-700/40 flex items-center gap-2.5">
        <div className="bg-white p-0.5 rounded-sm shrink-0">
          <div className="w-6 h-4 bg-orange-500 flex flex-col justify-around p-0.5">
            <div className="w-full h-[1px] bg-white/60" />
            <div className="w-full h-[1px] bg-white/60" />
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-white font-bold text-[12px] tracking-wide leading-tight truncate">Courier Intelligence</div>
          <div className="text-[10px] text-blue-200/60 font-medium truncate">Shangrila Tours</div>
        </div>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">

        <SectionLabel>Executive</SectionLabel>
        <NavItem to="/" icon={BarChart3} label="Executive Overview" />
        <NavItem to="/analytics" icon={Globe} label="Business Analytics" />
        <NavItem to="/search" icon={Search} label="Universal Search" />

        <SectionLabel>Customers</SectionLabel>
        <NavItem to="/customers" icon={Users} label="Customer Directory" />

        <SectionLabel>Operations</SectionLabel>
        <NavItem to="/awb" icon={Package} label="Air Waybills" />
        <NavItem to="/mawb" icon={FileText} label="Master AWBs" />

        <SectionLabel>Data Governance</SectionLabel>
        <NavItem to="/sync" icon={Database} label="CRM Sync" />
        <NavItem to="/matching" icon={Users} label="Matching Review" />
        <NavItem to="/quality" icon={ShieldCheck} label="Data Quality" />

        <SectionLabel>Admin</SectionLabel>
        {(['Users', 'Roles', 'Settings', 'Audit Logs'] as const).map((lbl) => (
          <button key={lbl} disabled
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-slate-600 rounded-md text-[12px] font-medium cursor-not-allowed opacity-40">
            <span className="w-3 h-3 rounded-sm bg-slate-600/40 shrink-0" />
            {lbl}
          </button>
        ))}

      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-blue-700/40 bg-blue-800">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-blue-300/70">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
          All systems operational
        </div>
      </div>
    </aside>
  );
}
