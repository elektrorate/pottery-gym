import React from 'react';
import ReactDOM from 'react-dom/client';
import DesignerApp from './DesignerApp';
import './designer.css';

// Casa Rosier bonos designer (same UI, card and PDF as bono-gift-card),
// served at /bonos-designer.html and embedded in /giftcards.
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <DesignerApp />
  </React.StrictMode>
);
