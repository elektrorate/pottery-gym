import React from 'react';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for database UUIDs. Short names such as «staff» stay visible. */
export const isInternalId = (value: string | null | undefined): boolean =>
  !!value && UUID.test(value.trim());

/** Technical reference, closed by default. Native details so it works without extra state. */
export function AdvancedDetails({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <details className={`ui-advanced${className ? ` ${className}` : ''}`}>
      <summary>Avanzado</summary>
      <div>{children}</div>
    </details>
  );
}
