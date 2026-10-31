import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Where page photos are kept when not in Postgres (31 Oct 2026): a private Cloudflare R2 bucket,
// reached with the S3 API. The bucket is never public: the API serves each photo itself, so a
// hidden page's photo stays hidden. Keys are opaque (`avatars/<profile>/<random>.webp`).

export interface PhotoStore {
  readonly endpoint: string;
  put(key: string, webp: Buffer): Promise<void>;
  /** The photo, or null when there is no such object. */
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Tests only: a stand-in for the account's R2 address. */
  endpoint?: string;
}

const NAMES = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
] as const;

/** R2 from the environment: all four settings, or none (photos then stay in Postgres). */
export function r2Settings(
  env: Record<string, string | undefined>,
): R2Settings | null {
  const missing = NAMES.filter((name) => !env[name]);
  if (missing.length === NAMES.length) return null;
  if (missing.length)
    throw new Error(
      `R2 needs all four settings; missing ${missing.join(', ')}`,
    );
  return {
    accountId: env['R2_ACCOUNT_ID']!,
    accessKeyId: env['R2_ACCESS_KEY_ID']!,
    secretAccessKey: env['R2_SECRET_ACCESS_KEY']!,
    bucket: env['R2_BUCKET']!,
  };
}

export function createR2PhotoStore(settings: R2Settings): PhotoStore {
  const endpoint =
    settings.endpoint ??
    `https://${settings.accountId}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    // A photo request must not hang the API: one retry, then the caller's error path.
    maxAttempts: 2,
  });
  const Bucket = settings.bucket;
  return {
    endpoint,
    async put(key, webp) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: webp,
          ContentType: 'image/webp',
          CacheControl: 'private, max-age=0',
        }),
      );
    },
    async get(key) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket, Key: key }),
        );
        if (!out.Body) return null;
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (error) {
        if (
          error instanceof NoSuchKey ||
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 404
        )
          return null;
        throw error;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
