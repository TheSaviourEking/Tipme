/** What a failed photo or cover upload says, in plain words. Shared so both read the same. */
export const photoErrors: Record<string, string> = {
  INVALID_IMAGE: 'Please choose a JPEG, PNG or WebP photo.',
  PAYLOAD_TOO_LARGE: 'That photo is over 5 MB. Please choose a smaller one.',
};

export const PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
