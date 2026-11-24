export const NOTIFICATION_EVENTS = [
  "notifyDiscoveryUpdated",
  "notifyFlowDone",
  "notifyRequestMade",
  "notifyRequestAvailable",
  "notifyArtistAdded",
  "notifyTrackAdded",
  "notifyPodcastEpisode",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
