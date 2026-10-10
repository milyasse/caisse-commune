/**
 * Aide à l'installation sur l'écran d'accueil (iPhone/iPad et Android)
 * et rappel de sauvegarde quand les données ne vivent que sur l'appareil.
 */
import React, { useEffect, useState } from 'react';
import { useStore } from '../store/store.ts';
import { PREVIEW } from './download.ts';
import { Icon } from './components/kit.tsx';

const KEY = 'caisse-commune:install-dismissed';
const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
const write = () => {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* stockage indisponible */
  }
};

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** Navigateurs intégrés (Facebook, Instagram, Messenger…) qui ne savent pas installer d'application. */
const inAppBrowser = () => /FBAN|FBAV|Instagram|Messenger|Line\/|Snapchat|TikTok/i.test(navigator.userAgent);

type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export function InstallBanner() {
  const [hidden, setHidden] = useState(read);
  const [bip, setBip] = useState<BIP | null>(null);
  useEffect(() => {
    const h = (e: Event) => (e.preventDefault(), setBip(e as BIP));
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (PREVIEW || hidden || isStandalone()) return null;
  const close = () => (write(), setHidden(true));

  if (isIOS())
    return (
      <div className="install">
        <div className="install-ic">
          <Icon name="in" size={20} />
        </div>
        <div className="install-t">
          <b>Installer sur l'iPhone</b>
          {inAppBrowser() ? (
            <span>Ouvrez d'abord ce lien dans Safari (menu ··· › « Ouvrir dans le navigateur »).</span>
          ) : (
            <span>
              Touchez <ShareGlyph /> <b>Partager</b> en bas de Safari, puis <b>« Sur l'écran d'accueil »</b> et <b>Ajouter</b>. L'application s'ouvrira ensuite en plein écran, même sans Internet.
            </span>
          )}
        </div>
        <button className="icon-btn" aria-label="Masquer" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
    );

  if (bip)
    return (
      <div className="install">
        <div className="install-ic">
          <Icon name="in" size={20} />
        </div>
        <div className="install-t">
          <b>Installer l'application</b>
          <span>Accès direct depuis l'écran d'accueil, fonctionne hors ligne.</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={async () => {
            await bip.prompt();
            setBip(null);
          }}
        >
          Installer
        </button>
      </div>
    );
  return null;
}

/** Icône « Partager » d'iOS (carré et flèche vers le haut). */
const ShareGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
    <path d="M12 3v12M8 7l4-4 4 4M5 11v9h14v-9" />
  </svg>
);

/** Rappel de sauvegarde : données uniquement locales et pas de sauvegarde depuis 30 jours. */
export function BackupReminder({ onOpen }: { onOpen: () => void }) {
  const { state: s, session, lastBackupAt } = useStore();
  const ops = s.payments.length + s.expenses.length;
  if (session || s.settings.isDemo || ops === 0) return null;
  const days = lastBackupAt ? (Date.now() - Date.parse(lastBackupAt)) / 86_400_000 : Infinity;
  if (days < 30) return null;
  return (
    <button className="demo-banner" onClick={onOpen}>
      {lastBackupAt ? `Dernière sauvegarde il y a ${Math.floor(days)} jours.` : 'Aucune sauvegarde pour l’instant.'} Vos données ne sont que sur ce téléphone : Paramètres › Sauvegarde et données.
    </button>
  );
}
