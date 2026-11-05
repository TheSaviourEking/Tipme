import type { NotificationPrefsView } from '@tipme/contracts';

export type PopupPrefs = Pick<
  NotificationPrefsView,
  'hideTipDetailsInPopups' | 'tipSound'
>;

/**
 * Before the preferences load, or if they can't be read: details hidden and no sound. A pop-up on a
 * shop counter must never name a supporter because a read failed (review M2).
 */
export const POPUP_PREFS_UNKNOWN: PopupPrefs = {
  hideTipDetailsInPopups: true,
  tipSound: false,
};

export function popupPrefsFrom(
  result: { ok: true; data: Partial<PopupPrefs> } | { ok: false },
): PopupPrefs {
  if (!result.ok) return POPUP_PREFS_UNKNOWN;
  // An API without the switches (an older copy) answers without them: their defaults.
  return {
    hideTipDetailsInPopups: result.data.hideTipDetailsInPopups ?? false,
    tipSound: result.data.tipSound ?? true,
  };
}
