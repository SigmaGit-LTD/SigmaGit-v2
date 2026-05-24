import { getObject, putObject, deleteObject, listObjects, objectExists, getObjectSize, deletePrefix, getObjectStream, getRepoPrefix, copyPrefix } from './storage';
import { Upload } from '@aws-sdk/lib-storage';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config';

const s3Configured = Boolean(
  config.storage.s3.endpoint &&
  config.storage.s3.region &&
  config.storage.s3.bucket &&
  config.storage.s3.accessKeyId &&
  config.storage.s3.secretAccessKey
);

export const s3Client = s3Configured
  ? new S3Client({
      endpoint: config.storage.s3.endpoint,
      region: config.storage.s3.region,
      credentials: {
        accessKeyId: config.storage.s3.accessKeyId,
        secretAccessKey: config.storage.s3.secretAccessKey,
      },
      forcePathStyle: true,
    })
  : null;

export const bucket = config.storage.s3.bucket;

export { getRepoPrefix, getObject, putObject, deleteObject, listObjects, objectExists, getObjectSize, deletePrefix, getObjectStream, copyPrefix };

export const uploadMultipart = async (
  key: string,
  body: Buffer | Uint8Array | ReadableStream,
  contentType?: string
): Promise<void> => {
  if (!s3Client) {
    throw new Error('S3 is not configured');
  }
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
  });

  await upload.done();
};
