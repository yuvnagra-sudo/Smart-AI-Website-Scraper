// AWS S3 storage helpers
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getS3Client(): S3Client {
  if (!ENV.awsAccessKeyId || !ENV.awsSecretAccessKey || !ENV.awsS3Bucket) {
    throw new Error(
      "AWS S3 credentials missing: set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET"
    );
  }
  return new S3Client({
    region: ENV.awsRegion,
    credentials: {
      accessKeyId: ENV.awsAccessKeyId,
      secretAccessKey: ENV.awsSecretAccessKey,
    },
  });
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const s3 = getS3Client();
  const key = normalizeKey(relKey);
  const body =
    typeof data === "string"
      ? Buffer.from(data, "utf-8")
      : Buffer.from(data as Uint8Array);

  await s3.send(
    new PutObjectCommand({
      Bucket: ENV.awsS3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: ENV.awsS3Bucket, Key: key }),
    { expiresIn: SIGNED_URL_EXPIRY_SECONDS }
  );

  return { key, url };
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const s3 = getS3Client();
  const key = normalizeKey(relKey);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: ENV.awsS3Bucket, Key: key }),
    { expiresIn: SIGNED_URL_EXPIRY_SECONDS }
  );
  return { key, url };
}
