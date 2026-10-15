/**
 * Puts the system's light or dark preference on the root element as CoreUI's theme attribute, and follows it while the page is open.
 * Returns a function that stops following.
 */
export function followColorScheme(win: Pick<Window, 'matchMedia'>, root: HTMLElement): () => void {
  const query = win.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { root.setAttribute('data-coreui-theme', query.matches ? 'dark' : 'light'); };
  apply();
  query.addEventListener('change', apply);
  return () => query.removeEventListener('change', apply);
}
