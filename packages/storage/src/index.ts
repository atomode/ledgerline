import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class ObjectNotFoundError extends Error {
  override readonly name = "ObjectNotFoundError";
}

/** Thin S3 wrapper. Works against AWS S3 and any S3-compatible store (SeaweedFS locally). */
export function createStorage(cfg: StorageConfig) {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });

  return {
    bucket: cfg.bucket,

    async getObject(key: string): Promise<Buffer> {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        if (!res.Body) throw new ObjectNotFoundError(key);
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (err instanceof NoSuchKey || err instanceof NotFound) throw new ObjectNotFoundError(key);
        throw err;
      }
    },

    async putObject(key: string, body: Buffer, contentType = "application/pdf"): Promise<void> {
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    /** Returns size in bytes, or null if the object does not exist. */
    async headObject(key: string): Promise<{ sizeBytes: number } | null> {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return { sizeBytes: res.ContentLength ?? 0 };
      } catch (err) {
        if (err instanceof NotFound || err instanceof NoSuchKey) return null;
        if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
          return null;
        throw err;
      }
    },

    presignPut(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
      return getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }),
        { expiresIn: expiresInSeconds },
      );
    },

    destroy: () => s3.destroy(),
  };
}
export type Storage = ReturnType<typeof createStorage>;
