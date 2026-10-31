import type { Provider } from '@nestjs/common';
import {
  createR2PhotoStore,
  r2Settings,
  type PhotoStore,
} from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';

/** Where page photos live: a private R2 bucket when configured, otherwise Postgres (null). */
export const PHOTO_STORE = Symbol('PHOTO_STORE');

export const photoStoreProvider: Provider = {
  provide: PHOTO_STORE,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): PhotoStore | null => {
    const settings = r2Settings({
      R2_ACCOUNT_ID: config.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: config.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: config.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: config.R2_BUCKET,
    });
    return settings ? createR2PhotoStore(settings) : null;
  },
};
