/** The part of the Screen Wake Lock API that is used. */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}
export interface WakeLockHost {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/**
 * Keeps the screen from sleeping while the page is visible, so a results board left on a table or a stand stays on.
 * A browser drops the lock whenever the page is hidden, so it is requested again when the page comes back. Browsers
 * without the API, or that refuse the request (low battery, a policy), simply let the screen sleep. Returns a function that
 * releases the lock and stops listening.
 */
export function keepScreenAwake(host: WakeLockHost, doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>): () => void {
  if (!host.wakeLock) return () => undefined;
  let lock: WakeLockSentinelLike | null = null;
  let stopped = false;

  const acquire = async (): Promise<void> => {
    if (stopped || lock || doc.visibilityState !== 'visible') return;
    try {
      const granted = await host.wakeLock!.request('screen');
      if (stopped) {
        void granted.release();
        return;
      }
      lock = granted;
      granted.addEventListener?.('release', () => { if (lock === granted) lock = null; });
    } catch {
      // refused: the screen sleeps as usual
    }
  };
  const onVisibility = (): void => { void acquire(); };

  doc.addEventListener('visibilitychange', onVisibility);
  void acquire();
  return () => {
    stopped = true;
    doc.removeEventListener('visibilitychange', onVisibility);
    void lock?.release();
    lock = null;
  };
}
