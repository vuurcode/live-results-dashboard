// ── Backend WebSocket message shapes ─────────────────────────────────────────

/** distance_meta message payload */
export interface DistanceMeta {
  id: string;
  name: string;
  event_number: number;
  is_live: boolean;
  is_mass_start: boolean;
  distance_meters: number | null;
  total_laps: number | null;
  any_finished: boolean;
  heat_groups: HeatGroupMeta[];
}

/** One heat entry inside distance_meta.heat_groups */
export interface HeatGroupMeta {
  heat: number;
  race_ids: string[];
}

/** competitor_update message payload */
export interface CompetitorUpdate {
  id: string;
  distance_id: string;
  start_number: string;
  name: string;
  heat: number;
  lane: string;
  laps_count: number;
  total_time: string;
  formatted_total_time: string;
  /** List of lapTime strings for each completed lap, in order; populated by backend on every update and full replay */
  lap_times: string[];
  laps_remaining: number | null;
  finished_rank: number | null;
  /** Computed by frontend: laps_remaining === 1 */
  is_final_lap: boolean;
  /** Computed by frontend: sort position (laps desc, time asc) */
  position: number;
  /** Computed by frontend: compared against previous position */
  position_change: 'up' | 'down' | null;
  /** Set by frontend on receive for flash-update animation */
  lastUpdated?: number;
  /** Computed by frontend grouping logic */
  group_number?: number | null;
  /** Computed by frontend grouping logic */
  gap_to_above?: string | null;
  /** Personal record time string (formatted, backend-provided); null if not set */
  personal_record: string | null;
  /** Competitor category (e.g. "DC1", "SC2"); null when absent */
  category: string | null;
  /** Reason the result is invalid (e.g. "DSQ", "DNS"); null when valid */
  invalid_reason: string | null;
  /** Remark string (e.g. "PB", "SB"); null when absent */
  remark: string | null;
}

// ── Frontend view state ───────────────────────────────────────────────────────

/** Full local state for one distance, assembled from backend messages */
export interface ProcessedDistance {
  id: string;
  name: string;
  eventNumber: number;
  isLive: boolean;
  isMassStart: boolean;
  distanceMeters: number | null;
  totalLaps: number | null;
  anyFinished: boolean;
  finishingLineAfter: string | null;
  /** Ordered list of competitors (sorted by frontend: laps desc, time asc) */
  processedRaces: CompetitorUpdate[];
  /** Computed by frontend from processedRaces + group threshold setting */
  standingsGroups: StandingsGroup[];
  heatGroups: HeatGroup[];
}

/** Resolved standings group for rendering (computed by frontend) */
export interface StandingsGroup {
  groupNumber: number;
  laps: number;
  leaderTime: string | null;
  gapToGroupAhead: string | null;
  timeBehindLeader: string | null;
  isLastGroup: boolean;
  /** True when this is the synthetic overflow "Others" group */
  isOthers: boolean;
  races: CompetitorUpdate[];
}

/** Resolved heat group for rendering */
export interface HeatGroup {
  heat: number;
  /** Authoritative race ID list from distance_meta; used for re-resolution on competitor updates */
  raceIds: string[];
  /** Fixed-slot array: index corresponds to LANE_ORDER position; null = lane absent in this heat */
  races: (CompetitorUpdate | null)[];
}

/** `window` as extended by public/env-inject.js. */
export interface BackendWindow extends Window {
  BACKEND_URL?: string;
}

/** What the data source says about the match: it answers, is not live (yet) or cannot be reached. */
export interface FeedStatus {
  state: 'ok' | 'not_live' | 'unavailable';
  /** The data source's own text for `not_live` (not localised). */
  message?: string;
}

/** Messages the backend sends over the WebSocket. */
export type BackendMessage =
  | { type: 'status'; data: { competition_id?: string; data_source_url: string; data_source_interval: number } }
  | { type: 'event_name'; data: { name: string } }
  | { type: 'error'; data: string }
  | { type: 'feed_status'; data: FeedStatus }
  | { type: 'reset' }
  | { type: 'distance_meta'; data: DistanceMeta }
  | { type: 'competitor_update'; data: CompetitorUpdate };

/** One entry of the backend's `/api/matches/today` list; `id` is the competitionId to follow. */
export interface TodayMatch {
  id: string;
  code: string;
  name: string;
  /** ISO start time (UTC) */
  start: string;
  end?: string;
  extra?: string;
  allowToSendLive: boolean;
  venue: { code: string; name: string; city: string };
}
