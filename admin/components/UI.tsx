
import React, { useEffect, useId } from 'react';

export const Icon = {
  Home: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5z" />
      <path d="M9 22V12h6v10" />
    </svg>
  ),
  Workshop: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12a2 2 0 0 1 2 2v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V5a2 2 0 0 1 2-2z" />
      <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M12 22v-5" />
    </svg>
  ),
  Chart: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </svg>
  ),
  ArrowUpRight: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17L17 7M17 7H8M17 7V16" />
    </svg>
  ),
  Filter: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16" y2="16" />
    </svg>
  ),
  Target: () => (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
    </svg>
  ),
  Refresh: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  ),
  Bell: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  Logout: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  More: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  ),
  IdCard: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="M7 8a2 2 0 1 1 4 0v2a2 2 0 1 1-4 0z" />
      <line x1="14" y1="8" x2="17" y2="8" />
      <line x1="14" y1="11" x2="17" y2="11" />
      <line x1="7" y1="15" x2="17" y2="15" />
    </svg>
  )
};

export const ActivityPill: React.FC<{
  label: string;
  value: string;
  status: string;
  percentage: string;
  iconBg: string;
}> = ({ label, value, status, percentage, iconBg }) => {
  const parts = value.split(' / ');

  return (
    <div className="activity-pill group !py-5 !px-5 md:!px-7 bg-white rounded-2xl flex items-center gap-5 border border-neutral-border transition-all">
      <div className="w-11 h-11 md:w-12 md:h-12 rounded-xl flex items-center justify-center text-white shrink-0" style={{ backgroundColor: iconBg }}>
        <Icon.ArrowUpRight />
      </div>
      <div className="flex-1 min-w-0">
        <p className="ui-label uppercase tracking-[0.12em] mb-1">{label}</p>
        <p className="text-[26px] md:text-[28px] font-bold text-neutral-textMain leading-none">
          {parts[0]}
          {parts[1] && <span className="text-neutral-textHelper font-medium"> / {parts[1]}</span>}
        </p>
      </div>
      <div className="text-right flex flex-col items-end shrink-0">
         <p className="ui-label uppercase tracking-[0.1em] mb-1">{status}</p>
        <p className="text-[22px] md:text-[24px] font-bold text-brand leading-none">{percentage}</p>
      </div>
    </div>
  );
};

export const DaySelector: React.FC<{ days: { num: string, name: string }[], activeDay: string }> = ({ days, activeDay }) => (
  <div className="flex items-center px-4 mb-8 overflow-x-auto gap-3 no-scrollbar py-2 -mx-4">
    {days.map(day => (
      <div
        key={day.num}
        className={`day-pill shrink-0 shadow-none outline-none ${day.num === activeDay ? 'day-pill-active' : 'text-neutral-textHelper hover:bg-white'}`}
      >
        <div className={`text-[24px] font-bold mb-0.5 leading-none ${day.num === activeDay ? 'text-white' : 'text-neutral-textMain'}`}>{day.num}</div>
        <div className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${day.num === activeDay ? 'text-white/70' : 'opacity-70'}`}>{day.name}</div>
      </div>
    ))}
  </div>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={`premium-card ${className}`}>
    {children}
  </div>
);

export const Button: React.FC<any> = ({ variant = 'primary', size = 'md', children, className, ...props }) => {
  const variants: any = {
    primary: "bg-brand text-white hover:bg-brand-hover shadow-sm transition-colors duration-200",
    dark: "bg-neutral-textMain text-neutral-base hover:bg-[#241A15] shadow-sm transition-colors duration-200",
    outline: "border border-neutral-border bg-white text-neutral-textMain hover:border-arena hover:text-brand transition-colors duration-200",
    ghost: "text-neutral-textHelper hover:text-brand transition-colors duration-200",
    danger: "bg-[#9E3B2B] text-white hover:bg-[#8A3325] shadow-sm transition-colors duration-200",
  };
  const sizes: any = {
    sm: "px-3.5 py-2.5 text-[13px] min-h-[40px]",
    md: "px-5 py-3 text-[14px] min-h-[44px]",
    lg: "px-6 py-3.5 text-[15px] min-h-[48px]"
  };
  return (
    <button className={`inline-flex items-center justify-center gap-2 font-semibold rounded-[10px] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
};

export const Toast: React.FC<any> = ({ message, type }) => (
  <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[100] animate-fade-in px-4 w-full max-w-sm">
     <div role="status" aria-live="polite" className={`px-5 py-3.5 rounded-xl shadow-lg text-white font-semibold flex items-center gap-3 ${type === 'error' ? 'bg-[#9E3B2B]' : 'bg-neutral-textMain text-neutral-base'}`}>
      <span className="text-base leading-none">{type === 'success' ? '✓' : 'ℹ'}</span>
      <span className="text-[14px]">{message}</span>
    </div>
  </div>
);

export const Badge: React.FC<{ children: React.ReactNode; variant?: 'default' | 'yellow' | 'success' | 'info' | 'error' | 'outline' | 'warning' | 'neutral' }> = ({ children, variant = 'default' }) => {
  const variants: any = {
    default: "bg-brand-soft text-brand",
    yellow: "bg-[#F7EAC8] text-[#7A5410]",
    success: "bg-[#DFF0E4] text-[#20663B]",
    info: "bg-[#E3EDF6] text-[#2B5C86]",
    error: "bg-[#F8E1DA] text-[#9E3B2B]",
    warning: "bg-[#FBEAD2] text-[#8A5517]",
    outline: "border border-neutral-border text-neutral-textHelper",
    neutral: "bg-neutral-alt text-neutral-textSec"
  };
   return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-[12px] font-semibold tracking-wide ${variants[variant]}`}>
      {children}
    </span>
  );
};

export const Input: React.FC<any> = ({ label, className, id, ...props }) => {
  const generatedId = useId();
  const inputId = id || `input-${generatedId.replace(/:/g, '')}`;
  return (
    <div className="w-full text-left">
      {label && <label htmlFor={inputId} className="ui-label mb-1.5 block">{label}</label>}
      <input
        id={inputId}
        className={`ui-control w-full px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none transition-all text-neutral-textMain placeholder:text-neutral-textHelper ${className}`}
        {...props}
      />
    </div>
  );
};

export const Select: React.FC<any> = ({ label, options, className, id, ...props }) => {
  const generatedId = useId();
  const selectId = id || `select-${generatedId.replace(/:/g, '')}`;
  return (
    <div className="w-full text-left">
      {label && <label htmlFor={selectId} className="ui-label mb-1.5 block">{label}</label>}
      <div className="relative">
        <select
          id={selectId}
          className={`ui-control w-full px-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none transition-all text-neutral-textMain appearance-none ${className}`}
          {...props}
        >
          {options.map((opt: any) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-neutral-textHelper">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
      </div>
    </div>
  );
};

export const EmptyState: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
  <div className="p-10 md:p-14 text-center bg-white rounded-2xl border border-dashed border-arena">
    <div className="w-14 h-14 bg-neutral-sec rounded-full flex items-center justify-center mx-auto mb-4 text-2xl">🏺</div>
    <h3 className="text-lg text-neutral-textMain mb-1">{title}</h3>
    {subtitle && <p className="text-sm text-neutral-textHelper">{subtitle}</p>}
  </div>
);

export const SearchPill: React.FC<any> = ({ value, onChange, placeholder }) => (
  <div className="relative w-full max-w-xl group">
    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-textHelper group-focus-within:text-brand transition-colors">
      <Icon.Filter />
    </div>
    <input
      type="text"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className="w-full min-h-[44px] pl-11 pr-4 py-2.5 rounded-[10px] bg-white border border-neutral-border focus:border-brand focus:ring-2 focus:ring-brand/15 outline-none transition-all text-[15px] text-neutral-textMain placeholder:text-neutral-textHelper"
    />
  </div>
);

export const ListCard: React.FC<{
  title: string;
  subtitle: string;
  info: string;
  badge?: string;
  onView: () => void;
  onEdit: () => void;
  onDelete?: () => void;
}> = ({ title, subtitle, info, badge, onView, onEdit, onDelete }) => (
  <div className="bg-white p-4 md:p-5 rounded-2xl border border-neutral-border hover:border-arena transition-all group flex flex-col md:flex-row md:items-center gap-4">
    <div className="w-11 h-11 bg-brand-soft rounded-xl flex items-center justify-center text-brand shrink-0 group-hover:bg-brand group-hover:text-white transition-colors">
      <Icon.IdCard />
    </div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-0.5">
        <h3 className="font-semibold text-[15px] text-neutral-textMain truncate">{title}</h3>
        {badge && <Badge variant="outline">{badge}</Badge>}
      </div>
      <p className="text-[12px] font-semibold text-brand uppercase tracking-[0.1em] mb-0.5">{subtitle}</p>
      <p className="text-[13px] text-neutral-textHelper truncate">{info}</p>
    </div>
    <div className="flex gap-2 shrink-0">
      <Button variant="outline" size="sm" onClick={onView}>VER</Button>
      <Button variant="dark" size="sm" onClick={onEdit}>EDITAR</Button>
      {onDelete && <Button variant="danger" size="sm" onClick={onDelete}>ELIMINAR</Button>}
    </div>
  </div>
);

export const Modal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode
}> = ({ isOpen, onClose, title, children, footer }) => {
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center p-0 md:p-6">
      <div className="fixed inset-0 bg-[#312620]/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true"></div>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl md:shadow-xl shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[92vh] animate-fade-in">
        <div className="px-5 md:px-7 py-4 md:py-5 border-b border-neutral-border flex justify-between items-center shrink-0">
          <h2 id={titleId} className="ui-section-title text-neutral-textMain">{title}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="w-10 h-10 rounded-full hover:bg-neutral-sec flex items-center justify-center transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B7666" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div className="px-5 md:px-7 py-5 overflow-y-auto no-scrollbar">
          {children}
        </div>
        {footer && (
          <div className="px-5 md:px-7 py-4 border-t border-neutral-border bg-neutral-sec flex justify-end gap-3 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
