import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  capitalizeEs,
  formatDate,
  madridDateKey,
  monthGrid,
  parseDateOnly,
  shiftMonth
} from '../../utils/dateFormat';

type DateFieldProps = {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
};

const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

/** Text date that always shows dd/mm/aaaa. The stored value stays yyyy-mm-dd. */
const DateField: React.FC<DateFieldProps> = ({
  value,
  onChange,
  id,
  name,
  required,
  disabled,
  readOnly,
  className,
  placeholder = 'dd/mm/aaaa',
  'aria-label': ariaLabel
}) => {
  const reactId = useId();
  const fieldId = id || reactId;
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => formatDate(value));
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const key = parseDateOnly(value) || madridDateKey();
    const [year, month] = key.split('-').map(Number);
    return { year, month };
  });
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!focused) setText(value ? formatDate(value) : '');
  }, [value, focused]);

  const placePopup = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 288;
    const height = 320;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight && rect.top > height ? rect.top - height - 6 : below;
    setPosition({ top, left });
  };

  useEffect(() => {
    if (!open) return;
    placePopup();
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', placePopup);
    window.addEventListener('scroll', placePopup, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', placePopup);
      window.removeEventListener('scroll', placePopup, true);
    };
  }, [open]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      setText('');
      onChange('');
      return;
    }
    const key = parseDateOnly(raw);
    if (!key) {
      setText(raw);
      return;
    }
    setText(formatDate(key));
    onChange(key);
  };

  const openCalendar = () => {
    if (disabled || readOnly) return;
    const key = parseDateOnly(value) || parseDateOnly(text) || madridDateKey();
    const [year, month] = key.split('-').map(Number);
    setView({ year, month });
    setOpen(true);
  };

  const selectDay = (key: string) => {
    onChange(key);
    setText(formatDate(key));
    setOpen(false);
  };

  const today = madridDateKey();
  const selected = parseDateOnly(value);
  const popup = open ? createPortal(
    <div
      ref={popupRef}
      role="dialog"
      aria-label={ariaLabel ? `Calendario de ${ariaLabel}` : 'Calendario'}
      className="w-72 rounded-xl border border-neutral-border bg-white p-3 text-neutral-textMain shadow-xl"
      style={{ position: 'fixed', top: position.top, left: position.left, zIndex: 400 }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" aria-label="Mes anterior" className="h-8 w-8 rounded-lg hover:bg-neutral-alt" onClick={() => setView(current => shiftMonth(current.year, current.month, -1))}>‹</button>
        <p className="text-[13px] font-semibold capitalize">{capitalizeEs(formatDate(`${view.year}-${String(view.month).padStart(2, '0')}-01`, 'monthYear'))}</p>
        <button type="button" aria-label="Mes siguiente" className="h-8 w-8 rounded-lg hover:bg-neutral-alt" onClick={() => setView(current => shiftMonth(current.year, current.month, 1))}>›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-neutral-textHelper">
        {WEEKDAYS.map(day => <span key={day} className="py-1">{day}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {monthGrid(view.year, view.month).map(cell => (
          <button
            key={cell.key}
            type="button"
            aria-label={formatDate(cell.key)}
            aria-pressed={cell.key === selected}
            onClick={() => selectDay(cell.key)}
            className={`h-8 rounded-lg text-[12px] font-semibold ${cell.key === selected ? 'bg-brand text-white' : cell.key === today ? 'ring-1 ring-brand text-brand' : cell.inMonth ? 'text-neutral-textMain hover:bg-brand-soft' : 'text-neutral-textHelper/50 hover:bg-neutral-alt'}`}
          >
            {cell.day}
          </button>
        ))}
      </div>
      <button type="button" className="mt-2 h-8 w-full rounded-lg text-[12px] font-semibold text-brand hover:bg-brand-soft" onClick={() => selectDay(today)}>Hoy</button>
    </div>,
    document.body
  ) : null;

  return (
    <div ref={rootRef} className="relative w-full">
      <input
        id={fieldId}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={focused ? text : (value ? formatDate(value) : '')}
        onFocus={() => { setFocused(true); setText(value ? formatDate(value) : text); }}
        onBlur={() => { setFocused(false); setText(value ? formatDate(value) : ''); }}
        onChange={event => commit(event.target.value)}
        className={className}
        style={{ paddingRight: '2.25rem' }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled || readOnly}
        aria-label="Abrir calendario"
        onMouseDown={event => event.preventDefault()}
        onClick={openCalendar}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-neutral-textHelper hover:bg-neutral-alt hover:text-brand disabled:opacity-40"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      </button>
      {popup}
    </div>
  );
};

export default DateField;
