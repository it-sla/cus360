import React from 'react';
import { Card } from '@/components/ui/card';
import { ArrowUpRight, ArrowDownRight, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

type LucideIcon = React.ForwardRefExoticComponent<LucideProps & React.RefAttributes<SVGSVGElement>>;

interface KpiCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: number; // percentage, positive or negative
  trendLabel?: string;
  subValue?: string;
  sparkline?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export function KpiCard({
  title,
  value,
  icon: Icon,
  trend,
  trendLabel,
  subValue,
  sparkline,
  className,
  onClick
}: KpiCardProps) {
  const isPositive = trend !== undefined && trend >= 0;
  // ponytail: regex detects free-text values (company names) vs numeric/currency
  const isTextValue = typeof value === 'string' && !/^[\$€£¥₹\d,.\-+%\s]+$/.test(value);

  return (
    <Card 
      onClick={onClick}
      className={cn(
        "p-4 rounded-lg border border-zinc-800 bg-zinc-900 flex flex-col justify-between relative overflow-hidden group transition-all duration-200 border-t-2 border-t-zinc-700/80 shadow-md",
        onClick ? "cursor-pointer hover:bg-zinc-800/90 hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-xl" : "",
        className
      )}
    >
      <div className="flex justify-between items-start mb-3 relative z-10 gap-1.5">
        <div className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wide text-zinc-400 leading-tight group-hover:text-zinc-200 transition-colors flex-1 min-w-0 break-words min-h-[2rem]">{title}</div>
        <Icon size={14} className="text-zinc-500 group-hover:text-zinc-100 group-hover:scale-110 transition-all shrink-0 mt-0.5" />
      </div>
      
      <div className="flex items-baseline gap-2 mb-2 relative z-10 min-w-0">
        <div
          className={cn(
            "font-black text-zinc-50 tracking-tight tabular-nums min-w-0",
            isTextValue ? "text-base font-bold leading-snug break-words" : "text-2xl leading-tight whitespace-nowrap"
          )}
          title={String(value)}
        >
          {value}
        </div>
        {subValue && (
          <span className="text-xs font-semibold text-zinc-400">{subValue}</span>
        )}
      </div>

      <div className="mt-auto pt-3 border-t border-zinc-800/80 flex items-center justify-between relative z-10">
        {trend !== undefined ? (
          <div className={cn("inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-bold", isPositive ? "text-emerald-400 bg-emerald-400/10" : "text-rose-400 bg-rose-400/10")}>
            {isPositive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {Math.abs(trend)}%
            {trendLabel && <span className="text-zinc-400 ml-1 font-semibold">{trendLabel}</span>}
          </div>
        ) : (
          <div className="h-4" /> // Spacer if no trend
        )}
      </div>

      {sparkline && (
        <div className="absolute bottom-0 right-0 left-0 h-12 opacity-50 -z-0 pointer-events-none">
          {sparkline}
        </div>
      )}
    </Card>
  );
}
