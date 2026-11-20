import React, { useEffect, useState } from 'react';
import { formatTime, parseTime } from '../../utils/dateFormat';

type TimeFieldProps = {
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

/** 24-hour time. The stored value stays HH:mm (or 24:00 for an end-of-day block). */
const TimeField: React.FC<TimeFieldProps> = ({
  value,
  onChange,
  id,
  name,
  required,
  disabled,
  readOnly,
  className,
  placeholder = '18:30',
  'aria-label': ariaLabel
}) => {
  const shown = value ? formatTime(value) : '';
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      setText('');
      onChange('');
      return;
    }
    const parsed = parseTime(raw);
    if (!parsed) {
      setText(raw);
      return;
    }
    setText(parsed);
    onChange(parsed);
  };

  return (
    <input
      id={id}
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
      title="Hora en formato 24 h, por ejemplo 18:30"
      value={focused ? text : shown}
      onFocus={() => { setFocused(true); setText(shown); }}
      onBlur={() => { setFocused(false); setText(shown); }}
      onChange={event => commit(event.target.value)}
      className={className}
    />
  );
};

export default TimeField;
