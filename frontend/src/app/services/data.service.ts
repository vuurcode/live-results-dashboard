import { Injectable, NgZone, inject } from '@angular/core';
import { TranslateService } from './translate.service';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { BehaviorSubject, Subject } from 'rxjs';
import {
  BackendMessage,
  BackendWindow,
  DistanceMeta,
  CompetitorUpdate,
  ProcessedDistance,
  StandingsGroup,
} from '../models/data.models';
import { recomputePositions, recomputeGroups, resolveRaces } from '../logic/standings.util';
import { FeedStatus, TodayMatch } from '../models/data.models';
import { competitionIdFromSearch, withCompetitionId } from '../logic/competition.util';

export interface BackendStatus {
  status: 'Disconnected' | 'Connecting...' | 'Connected' | 'Error' | 'No match';
  url: string;
  interval: number | null;
  errorMessage?: string | null;
}

/** Close code the backend uses to refuse a connection that names no valid competition. */
const CLOSE_NO_COMPETITION = 1008;
const RENDER_INTERVAL_MS = 250;
const DEFAULT_GROUP_THRESHOLD = 2.0;
const MAX_GROUP_THRESHOLD = 10.0;
const DEFAULT_MAX_GROUPS = 4;
const DEFAULT_LAP_VARIANCE = 5;
const DEFAULT_LAP_VARIANCE_TIMED = 0.5;
const STORAGE_KEY_LAP_VARIANCE_TIMED = 'lapVariancePctTimed';
const STORAGE_KEY_THRESHOLD = 'groupThresholdSec';
const STORAGE_KEY_MAX_GROUPS = 'maxGroups';
const STORAGE_KEY_LAP_VARIANCE = 'lapVariancePct';
const STORAGE_KEY_SHOW_LAP_TIMES = 'showMassStartLapTimes';
const STORAGE_KEY_FOLLOW = 'follow';
const STORAGE_KEY_THOUSANDTHS = 'thousandths';
const STORAGE_KEY_COMPACT_COLORS = 'compactColors';

@Injectable({ providedIn: 'root' })
export class DataService {
  private socket$: WebSocketSubject<BackendMessage> | null = null;
  /** Competition to follow, from the page URL (`?competitionId=...`); without one nothing is followed. */
  public readonly competitionId = competitionIdFromSearch(window.location.search);
  private readonly BACKEND_URL = withCompetitionId((() => {
    const raw = (window as BackendWindow).BACKEND_URL;
    // Ignore unsubstituted template placeholder (env-inject.js not processed by envsubst)
    const base = raw && !raw.startsWith('${') ? raw : null;
    if (base) {
      const wsUrl = base.replace(/^http/, 'ws') + '/ws';
      // Mixed content: page is HTTPS but WS target is ws:// — use nginx proxy on current host
      if (window.location.protocol === 'https:' && wsUrl.startsWith('ws://')) {
        return `wss://${window.location.host}/ws`;
      }
      return wsUrl;
    }
    // Fall back to /ws on the current host — works with nginx proxy (prod) and ng proxy (dev)
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  })(), this.competitionId);
  private readonly BACKEND_HTTP_URL: string = (() => {
    const raw = (window as BackendWindow).BACKEND_URL;
    return raw && !raw.startsWith('${') ? raw : `${window.location.protocol}//${window.location.host}`;
  })();

  /** Matches happening today, from the backend; an empty list when it cannot be loaded. */
  async todayMatches(): Promise<TodayMatch[]> {
    try {
      const res = await fetch(`${this.BACKEND_HTTP_URL}/api/matches/today`);
      if (!res.ok) return [];
      const list: unknown = await res.json();
      return Array.isArray(list) ? (list as TodayMatch[]) : [];
    } catch {
      return [];
    }
  }

  private _status = new BehaviorSubject<BackendStatus>({ status: 'Disconnected', url: '', interval: null });
  public status$ = this._status.asObservable();
  private _reset = new Subject<void>();
  public reset$ = this._reset.asObservable();
  private _processedData = new BehaviorSubject<ProcessedDistance[]>([]);
  public processedData$ = this._processedData.asObservable();
  private _eventName = new BehaviorSubject<string>('');
  public eventName$ = this._eventName.asObservable();
  private _feed = new BehaviorSubject<FeedStatus | null>(null);
  /** The data source's state as reported by the backend; null until it has answered. */
  public feed$ = this._feed.asObservable();

  private _errors = new BehaviorSubject<string[]>([]);
  public errors$ = this._errors.asObservable();
  private _groupThreshold = new BehaviorSubject<number>(this._loadThreshold());
  public groupThreshold$ = this._groupThreshold.asObservable();

  private _displayedGroups = new BehaviorSubject<Map<string, StandingsGroup[]>>(new Map());
  public displayedGroups$ = this._displayedGroups.asObservable();
  private _groupDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private _maxGroups = new BehaviorSubject<number>(this._loadMaxGroups());
  public maxGroups$ = this._maxGroups.asObservable();

  get groupThreshold(): number { return this._groupThreshold.value; }
  get maxGroups(): number { return this._maxGroups.value; }

  private _lapVariance = new BehaviorSubject<number>(this._loadLapVariance());
  get lapVarianceThreshold(): number { return this._lapVariance.value; }

  setLapVarianceThreshold(value: number) {
    const clamped = Math.max(0, Math.round(value));
    this._lapVariance.next(clamped);
    try { localStorage.setItem(STORAGE_KEY_LAP_VARIANCE, String(clamped)); } catch { /* noop */ }
  }

  private _loadLapVariance(): number {
    try {
      const v = localStorage.getItem(STORAGE_KEY_LAP_VARIANCE);
      if (v !== null) return Math.max(0, parseInt(v, 10));
    } catch { /* noop */ }
    return DEFAULT_LAP_VARIANCE;
  }

  // long track has its own threshold: its laps are far more even than mass start laps
  private _lapVarianceTimed = new BehaviorSubject<number>(this._loadLapVarianceTimed());
  get lapVarianceThresholdTimed(): number { return this._lapVarianceTimed.value; }

  setLapVarianceThresholdTimed(value: number) {
    const clamped = Math.max(0, Math.round(value * 10) / 10); // one decimal: long track laps are even
    this._lapVarianceTimed.next(clamped);
    try { localStorage.setItem(STORAGE_KEY_LAP_VARIANCE_TIMED, String(clamped)); } catch { /* noop */ }
  }

  private _loadLapVarianceTimed(): number {
    try {
      const v = localStorage.getItem(STORAGE_KEY_LAP_VARIANCE_TIMED);
      if (v !== null && !isNaN(parseFloat(v))) return Math.max(0, Math.round(parseFloat(v) * 10) / 10);
    } catch { /* noop */ }
    return DEFAULT_LAP_VARIANCE_TIMED;
  }

  private _showMassLapTimes = new BehaviorSubject<boolean>(this._loadShowLapTimes());
  get showMassStartLapTimes(): boolean { return this._showMassLapTimes.value; }

  setShowMassStartLapTimes(value: boolean) {
    this._showMassLapTimes.next(value);
    try { localStorage.setItem(STORAGE_KEY_SHOW_LAP_TIMES, String(value)); } catch { /* noop */ }
  }

  private _loadShowLapTimes(): boolean {
    try {
      const v = localStorage.getItem(STORAGE_KEY_SHOW_LAP_TIMES);
      if (v !== null) return v !== 'false';
    } catch { /* noop */ }
    return true;
  }

  /** Compact display of long-track cards: lap time badges on one wrapping row until the final time is known. On by default. */
  /** Compact long-track badges coloured by variance against the previous lap, like mass start. Off by default. */
  private _compactColors = new BehaviorSubject<boolean>(this._loadCompactColors());
  get compactColors(): boolean { return this._compactColors.value; }

  setCompactColors(value: boolean) {
    this._compactColors.next(value);
    try { localStorage.setItem(STORAGE_KEY_COMPACT_COLORS, String(value)); } catch { /* noop */ }
  }

  private _loadCompactColors(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_COMPACT_COLORS) === 'true';
    } catch { /* noop */ }
    return false;
  }

  /** Long-track times show hundredths by default; thousandths only when switched on (or needed to settle a PB). */
  private _showThousandths = new BehaviorSubject<boolean>(this._loadShowThousandths());
  get showThousandths(): boolean { return this._showThousandths.value; }

  setShowThousandths(value: boolean) {
    this._showThousandths.next(value);
    try { localStorage.setItem(STORAGE_KEY_THOUSANDTHS, String(value)); } catch { /* noop */ }
  }

  private _loadShowThousandths(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_THOUSANDTHS) === 'true';
    } catch { /* noop */ }
    return false;
  }

  private _follow = new BehaviorSubject<boolean>(this._loadFollow());
  get follow(): boolean { return this._follow.value; }

  setFollow(value: boolean) {
    this._follow.next(value);
    try { localStorage.setItem(STORAGE_KEY_FOLLOW, String(value)); } catch { /* noop */ }
  }

  private _loadFollow(): boolean {
    try {
      const v = localStorage.getItem(STORAGE_KEY_FOLLOW);
      if (v !== null) return v !== 'false';
    } catch { /* noop */ }
    return false;
  }

  setGroupThreshold(value: number) {
    const clamped = Math.min(MAX_GROUP_THRESHOLD, Math.max(0, value));
    this._groupThreshold.next(clamped);
    try { localStorage.setItem(STORAGE_KEY_THRESHOLD, String(clamped)); } catch { /* noop */ }
    for (const dist of this.distanceMap.values()) {
      if (dist.isMassStart) this._recomputeGroups(dist);
    }
    // Flush debounce timers and immediately apply new groups
    for (const timer of this._groupDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this._groupDebounceTimers.clear();
    this._flushDisplayedGroups();
    this.ngZone.run(() => this._publishState());
  }

  setMaxGroups(value: number) {
    const clamped = Math.max(0, Math.round(value));
    this._maxGroups.next(clamped);
    try { localStorage.setItem(STORAGE_KEY_MAX_GROUPS, String(clamped)); } catch { /* noop */ }
    for (const dist of this.distanceMap.values()) {
      if (dist.isMassStart) this._recomputeGroups(dist);
    }
    for (const timer of this._groupDebounceTimers.values()) clearTimeout(timer);
    this._groupDebounceTimers.clear();
    this._flushDisplayedGroups();
    this.ngZone.run(() => this._publishState());
  }

  private _loadMaxGroups(): number {
    try {
      const v = localStorage.getItem(STORAGE_KEY_MAX_GROUPS);
      if (v !== null) return Math.max(0, parseInt(v, 10));
    } catch { /* noop */ }
    return DEFAULT_MAX_GROUPS;
  }

  private _loadThreshold(): number {
    try {
      const v = localStorage.getItem(STORAGE_KEY_THRESHOLD);
      if (v !== null) return parseFloat(v);
    } catch { /* noop */ }
    return DEFAULT_GROUP_THRESHOLD;
  }

  private distanceMap = new Map<string, ProcessedDistance>();
  private competitorMap = new Map<string, Map<string, CompetitorUpdate>>();
  private queue: BackendMessage[] = [];
  private renderLoopRunning = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private noCompetition = false;
  private ngZone = inject(NgZone);
  private ts = inject(TranslateService);

  constructor() {
    this.connect();
  }

  connect() {
    if (this.socket$ && !this.socket$.closed) return;
    if (!this.competitionId) {
      this._status.next({ status: 'No match', url: '', interval: null });
      return;
    }
    this._errors.next([]);
    this._feed.next(null);
    this._status.next({ status: 'Connecting...', url: '', interval: null });
    this.noCompetition = false;
    this.socket$ = webSocket<BackendMessage>({
      url: this.BACKEND_URL,
      closeObserver: { next: (e: CloseEvent) => { this.noCompetition = e.code === CLOSE_NO_COMPETITION; } },
    });
    this.socket$.subscribe({
      next: (msg) => this._enqueue(msg),
      error: (err: unknown) => this._handleError(err),
      complete: () => this._handleDisconnect(),
    });
  }

  disconnect() {
    this._cancelReconnect();
    this.socket$?.complete();
    this.socket$ = null;
    this._status.next({ status: 'Disconnected', url: '', interval: null });
  }

  resetDashboard() {
    localStorage.clear();
    window.location.reload();
  }

  private _enqueue(msg: BackendMessage) {
    this.queue.push(msg);
    if (!this.renderLoopRunning) {
      this.renderLoopRunning = true;
      this.ngZone.runOutsideAngular(() => this._scheduleNextCycle());
    }
  }

  private _scheduleNextCycle() {
    setTimeout(() => this._runCycle(), 0);
  }

  private _runCycle() {
    if (this.queue.length === 0) { this.renderLoopRunning = false; return; }
    const deadline = Date.now() + RENDER_INTERVAL_MS;
    let changed = false;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const msg = this.queue.shift();
      if (msg) changed = this._applyMessage(msg) || changed;
    }
    if (changed) {
      // Flush groups immediately so the strip renders on initial load
      // (debounce will still update it again after the threshold delay)
      this._flushDisplayedGroups();
      this.ngZone.run(() => this._publishState());
    }
    if (this.queue.length > 0) this._scheduleNextCycle();
    else this.renderLoopRunning = false;
  }

  private _applyMessage(msg: BackendMessage): boolean {
    switch (msg.type) {
      case 'status':
        this._cancelReconnect();
        this.clearErrors();
        this.ngZone.run(() => this._status.next({
          status: 'Connected',
          url: msg.data.data_source_url,
          interval: msg.data.data_source_interval,
          errorMessage: null,
        }));
        return false;
      case 'feed_status':
        this.ngZone.run(() => this._feed.next(msg.data));
        return false;
      case 'event_name':
        this.ngZone.run(() => this._eventName.next(msg.data.name));
        return false;
      case 'error':
        this.ngZone.run(() => this._status.next({
          ...this._status.value,
          status: 'Error',
          errorMessage: msg.data,
        }));
        return false;
      case 'reset':
        this._applyReset();
        return false;
      case 'distance_meta':
        return this._applyDistanceMeta(msg.data);
      case 'competitor_update':
        return this._applyCompetitorUpdate(msg.data);
      default:
        return false;
    }
  }

  private _applyReset(): void {
    this.distanceMap.clear();
    this.competitorMap.clear();
    for (const timer of this._groupDebounceTimers.values()) clearTimeout(timer);
    this._groupDebounceTimers.clear();
    this.ngZone.run(() => {
      this._eventName.next('');
      this._processedData.next([]);
      this._displayedGroups.next(new Map());
      this._reset.next();
    });
  }

  private _applyDistanceMeta(meta: DistanceMeta): boolean {
    let dist = this.distanceMap.get(meta.id);
    if (!dist) {
      dist = {
        id: meta.id, name: meta.name, eventNumber: meta.event_number,
        isLive: meta.is_live, isMassStart: meta.is_mass_start,
        distanceMeters: meta.distance_meters, totalLaps: meta.total_laps,
        anyFinished: meta.any_finished, finishingLineAfter: null,
        processedRaces: [], standingsGroups: [], heatGroups: [],
      };
      this.distanceMap.set(meta.id, dist);
    } else {
      dist.name = meta.name; dist.eventNumber = meta.event_number;
      dist.isLive = meta.is_live; dist.isMassStart = meta.is_mass_start;
      dist.distanceMeters = meta.distance_meters; dist.totalLaps = meta.total_laps;
      dist.anyFinished = meta.any_finished;
      // finishingLineAfter is intentionally NOT updated from the backend here;
      // it is computed instantly by _recomputeFinishingLine on every competitor update.
    }
    dist.heatGroups = meta.heat_groups.map(hg => ({
      heat: hg.heat,
      raceIds: hg.race_ids,
      races: this._resolveRaces(meta.id, hg.race_ids, !meta.is_mass_start),
    }));
    return true;
  }

  private _applyCompetitorUpdate(comp: CompetitorUpdate): boolean {
    comp.lastUpdated = Date.now();
    let distComps = this.competitorMap.get(comp.distance_id);
    if (!distComps) { distComps = new Map(); this.competitorMap.set(comp.distance_id, distComps); }

    const dist = this.distanceMap.get(comp.distance_id);
    if (dist) {
      const existing = distComps.get(comp.id);

      // Ensure frontend-only fields are preserved / initialised
      comp.position = existing?.position ?? 0;
      comp.position_change = null;
      comp.is_final_lap = false;
      comp.group_number = existing?.group_number ?? null;
      comp.gap_to_above = existing?.gap_to_above ?? null;
      // Replace the competitor with a new object (never mutate it): OnPush row components only
      // re-render when their input reference changes. Rows are tracked by id, so the DOM item
      // is kept and the flash animation still plays at the competitor's CURRENT row position.
      if (existing) {
        distComps.set(comp.id, { ...existing, ...comp });
      } else {
        distComps.set(comp.id, comp);
        dist.processedRaces = [...dist.processedRaces, comp];
      }

      // Derive is_final_lap in the frontend
      const target = distComps.get(comp.id)!;
      target.is_final_lap = target.laps_remaining === 1;

      // Recompute positions and resort immediately — before highlight and finishing line
      recomputePositions(Array.from(distComps.values()));
      dist.processedRaces = Array.from(distComps.values()).sort((a, b) => a.position - b.position);

      // Set finishing line to this competitor; persists until the next update moves it
      dist.finishingLineAfter = comp.id;

      if (dist.isMassStart) {
        this._recomputeGroups(dist);
        this._scheduleGroupDebounce(comp.distance_id);
      } else {
        dist.heatGroups.forEach(hg => {
          hg.races = this._resolveRaces(comp.distance_id, hg.raceIds, true);
        });
      }
    } else {
      comp.position = 0;
      comp.position_change = null;
      comp.is_final_lap = false;
      distComps.set(comp.id, comp);
    }

    return true;
  }

  private _recomputeGroups(dist: ProcessedDistance) {
    dist.standingsGroups = recomputeGroups(
      dist.processedRaces,
      this._groupThreshold.value,
      this._maxGroups.value,
      (n) => this.ts.t(n === 1 ? 'lapUnit' : 'lapsUnit'),
    ) as StandingsGroup[];
  }

  private _scheduleGroupDebounce(distId: string) {
    const existing = this._groupDebounceTimers.get(distId);
    if (existing) clearTimeout(existing);
    const thresholdMs = this._groupThreshold.value * 1000;
    const timer = setTimeout(() => {
      this._groupDebounceTimers.delete(distId);
      this._flushDisplayedGroups();
    }, thresholdMs);
    this._groupDebounceTimers.set(distId, timer);
  }

  private _flushDisplayedGroups() {
    const map = new Map<string, StandingsGroup[]>();
    for (const [id, dist] of this.distanceMap) {
      if (dist.isMassStart) map.set(id, dist.standingsGroups);
    }
    this.ngZone.run(() => this._displayedGroups.next(map));
  }

  private _resolveRaces(distId: string, ids: string[], pinnedByLane = false): (CompetitorUpdate | null)[] {
    return resolveRaces(ids, this.competitorMap.get(distId), pinnedByLane);
  }

  private _publishState() {
    const distances = Array.from(this.distanceMap.values())
      .sort((a, b) => b.eventNumber - a.eventNumber);
    this._processedData.next(distances);
  }


  addError(msg: string) {
    this._errors.next([...this._errors.value, msg]);
  }

  dismissError(index: number) {
    const current = [...this._errors.value];
    current.splice(index, 1);
    this._errors.next(current);
  }

  clearErrors() {
    this._errors.next([]);
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  private _cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Reconnecting cannot help when no competition was chosen; the viewer has to pick a match. */
  private _stopForNoCompetition(): boolean {
    if (!this.noCompetition) return false;
    this.socket$ = null;
    this._status.next({ status: 'No match', url: '', interval: null });
    return true;
  }

  private _handleError(err: unknown) {
    if (this._stopForNoCompetition()) return;
    console.error('WebSocket error:', err);
    this.addError('Connection to backend lost. Reconnecting in 5s…');
    this.socket$ = null;
    this._status.next({ status: 'Error', url: '', interval: null });
    this._scheduleReconnect();
  }

  private _handleDisconnect() {
    if (this._stopForNoCompetition()) return;
    if (
      this._status.value.status === 'Connected' ||
      this._status.value.status === 'Connecting...'
    ) {
      this.addError('Connection to backend lost. Reconnecting in 5s…');
    }
    this.socket$ = null;
    this._status.next({ status: 'Disconnected', url: '', interval: null });
    this._scheduleReconnect();
  }
}
