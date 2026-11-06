import {
  businessLiveAudience,
  type BusinessLiveRef,
  type Database,
} from '@tipme/database';
import type { PublishLive } from '../live/live-publisher.js';

/**
 * `business.changed` to everyone a committed business change concerns (plan B9 Task 23): the
 * business's managers and team, and the person it is about. Call it after the write resolved, and
 * never await it: a failed lookup or publish only means the page catches up on its next read.
 */
export function signalBusiness(
  db: Database,
  publishLive: PublishLive,
  ref: BusinessLiveRef,
): void {
  void businessLiveAudience(db, ref)
    .then((users) =>
      Promise.all(
        users.map((user) =>
          publishLive({ to: { user }, type: 'business.changed' }),
        ),
      ),
    )
    .catch(() => undefined);
}
