import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Open a link in the user's own browser. In the desktop app that is Tauri's opener plugin, because
 * a link followed inside the app's window would navigate the app itself; in a plain browser (the
 * dev page) it is a new tab.
 *
 * Only http(s) links are opened, whatever is passed in. The links come from the website's data
 * and are already limited to the origin the user pasted (see `sameOriginHttpUrl`); this is a
 * second check at the last step.
 */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  if ('__TAURI_INTERNALS__' in window) {
    try {
      await openUrl(parsed.href);
      return;
    } catch {
      // fall through to the browser way
    }
  }
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
