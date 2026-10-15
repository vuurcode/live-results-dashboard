import { Observable } from 'rxjs';

export type ColorSchemeChoice = 'auto' | 'light' | 'dark';

/**
 * Puts the light or dark theme on the root element as CoreUI's theme attribute: the system's preference for `auto`
 * (also while the page is open), otherwise the choice itself. Returns a function that stops following.
 */
export function followColorScheme(win: Pick<Window, 'matchMedia'>, root: HTMLElement, choice$: Observable<ColorSchemeChoice>): () => void {
  const query = win.matchMedia('(prefers-color-scheme: dark)');
  let choice: ColorSchemeChoice = 'auto';
  const apply = () => {
    const dark = choice === 'auto' ? query.matches : choice === 'dark';
    root.setAttribute('data-coreui-theme', dark ? 'dark' : 'light');
  };
  const subscription = choice$.subscribe((next) => { choice = next; apply(); });
  query.addEventListener('change', apply);
  return () => { subscription.unsubscribe(); query.removeEventListener('change', apply); };
}
