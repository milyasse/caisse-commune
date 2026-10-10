import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';

createRoot(document.getElementById('root')!).render(<App />);

// PWA : mise en cache pour le fonctionnement hors ligne (uniquement en https / localhost)
if ('serviceWorker' in navigator && location.protocol !== 'file:' && document.querySelector('link[rel=manifest]')) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
