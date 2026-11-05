/**
 * Whether the dashboard opens a live stream: only once the profile has loaded and its first read
 * said live updates are on (GET /v1/me/profile's `liveUpdates`). Off, the page makes exactly the
 * requests it made before the feature.
 */
export function liveProviderEnabled(o: {
  profile: object | null;
  liveUpdates: boolean;
}): boolean {
  return o.profile !== null && o.liveUpdates;
}
