
export interface Translations {
  // Page
  pageTitle: string;
  // Topbar buttons
  displaySettings: string;
  massStartSettings: string;
  // Follow setting
  todayMatchesLabel: string;
  noMatchOption: string;
  selectMatchHint: string;
  noLiveMatchesHint: string;
  thousandthsLabel: string;
  hundredthsLabel: string;
  thousandthsPopoverTitle: string;
  thousandthsPopoverBody: string;
  compactColorsLabel: string;
  compactColorsPopoverTitle: string;
  compactColorsPopoverBody: string;
  feedNotLiveTitle: string;
  feedNotLiveBody: string;
  feedSourceMessage: string;
  disclaimer: string;
  disclaimerLabel: string;
  disclaimerOwnership: string;
  feedUnavailableTitle: string;
  feedUnavailableBody: string;
  feedEmptyTitle: string;
  feedEmptyBody: string;
  feedNoMatchTitle: string;
  feedNoMatchBody: string;
  feedDisconnectedTitle: string;
  feedDisconnectedBody: string;
  feedSlowTitle: string;
  feedSlowBody: string;
  tooltipDistance: string;
  tooltipLapTime: string;
  tooltipTotalTime: string;
  followLabel: string;
  followPopoverTitle: string;
  followPopoverBody: string;
  // Max gap setting
  maxGapLabel: string;
  maxGapPopoverTitle: string;
  maxGapPopoverBody: string;
  // Max groups setting
  maxGroupsLabel: string;
  maxGroupsPopoverTitle: string;
  maxGroupsPopoverBody: string;
  // Lap variance setting
  lapDeltaLabel: string;
  lapVariancePopoverTitle: string;
  lapVariancePopoverBody: string;
  lapVariancePopoverExample: string;
  // Lap times setting
  lapTimesLabel: string;
  showLapTimesPopoverTitle: string;
  showLapTimesPopoverBody: string;
  // Badges
  badgeLive: string;
  badgeDone: string;
  badgeLeader: string;
  badgeFinalLap: string;
  // Distance header
  lapUnit: string;
  lapsUnit: string;
  // Groups / heats
  headOfRace: string;
  tailOfRace: string;
  groupLabel: string;  // contains {n}
  heatLabel: string;   // contains {n}
  heatMergedLabel: string; // contains {a} and {b}
  // Race events
  lapCompleted: string;
  finished: string;
  finishLabel: string;
  // Timed personal best label and remarks
  pbCurrentLabel: string;
  pbPreviousLabel: string;
  remarkNewPb: string;
  remarkShortPb: string;
  pbImprovedTitle: string;
  remarkFall: string;
  remarkDisqualified: string;
  remarkDidNotStart: string;
  remarkDidNotFinish: string;
  remarkWithdrawn: string;
  remarkManualTime: string;
  genderWomen: string;
  genderMen: string;
  categoryPupils: string;
  categoryJuniors: string;
  categoryNeoSeniors: string;
  categorySeniors: string;
  categoryMasters: string;
  remarkWorldRecord: string;
  remarkNationalRecord: string;
  remarkNewTrackRecord: string;
  remarkTrackRecordCourse: string;
  // Mass start lap counter (HTML, contains underline span)
  moreLapAfterRound: string;   // singular
  moreLapsAfterRound: string;  // plural
}
