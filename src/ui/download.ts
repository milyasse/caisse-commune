/** Téléchargement / partage / impression de fichiers générés dans le navigateur. */
declare const __PREVIEW__: boolean | undefined;
/** Vrai dans l'aperçu publié sur claude.ai, où téléchargements et impression sont bloqués. */
export const PREVIEW = typeof __PREVIEW__ !== 'undefined' && !!__PREVIEW__;
const blocked = () => {
  throw new Error('Aperçu en ligne : téléchargements et impression sont bloqués ici. Ils fonctionnent dans l\u2019application installée.');
};
export async function saveFile(name: string, data: Uint8Array | string, mime: string) {
  if (PREVIEW) blocked();
  const blob = new Blob([data as BlobPart], { type: mime });
  const file = new File([blob], name, { type: mime });
  // Sur mobile, la feuille de partage permet d'envoyer par WhatsApp, e-mail, Drive…
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      await nav.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Imprime un rapport HTML (→ « Enregistrer en PDF » dans la boîte d'impression). */
export function printHtml(html: string) {
  if (PREVIEW) blocked();
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const doc = f.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    f.contentWindow!.focus();
    f.contentWindow!.print();
    setTimeout(() => f.remove(), 60_000);
  }, 300);
}
