
import { cn } from '@/lib/utils';
import { AlertTriangle, Info, CheckCircle2, XCircle } from 'lucide-react';

export type AlertType = 'critical' | 'warning' | 'info' | 'success';

interface AlertBannerProps {
  type: AlertType;
  message: string;
  count?: number;
  className?: string;
}

const typeConfig = {
  critical: {
    icon: XCircle,
    bgClass: 'bg-danger/10',
    textClass: 'text-danger',
    borderClass: 'border-danger/20'
  },
  warning: {
    icon: AlertTriangle,
    bgClass: 'bg-warning/10',
    textClass: 'text-warning',
    borderClass: 'border-warning/20'
  },
  info: {
    icon: Info,
    bgClass: 'bg-primary/10',
    textClass: 'text-primary',
    borderClass: 'border-primary/20'
  },
  success: {
    icon: CheckCircle2,
    bgClass: 'bg-success/10',
    textClass: 'text-success',
    borderClass: 'border-success/20'
  }
};

export function AlertBanner({ type, message, count, className }: AlertBannerProps) {
  const config = typeConfig[type];
  const Icon = config.icon;

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold whitespace-nowrap shadow-sm",
      config.bgClass,
      config.textClass,
      config.borderClass,
      className
    )}>
      <Icon size={14} strokeWidth={2.5} />
      <span>{message}</span>
      {count !== undefined && (
        <span className={cn("ml-1 px-1.5 py-0.5 rounded-full bg-white/50 text-[10px]")}>
          {count}
        </span>
      )}
    </div>
  );
}
