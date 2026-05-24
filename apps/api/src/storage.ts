import { readdir, readFile, writeFile, unlink, mkdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { config } from './config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { withTimeout, MAX_LOCAL_LIST_KEYS } from './middleware/limits';

export type StorageType = 's3' | 'local';

export interface StorageBackend {
  type: StorageType;
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer | Uint8Array | string, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSize(key: string): Promise<number | null>;
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
  copyPrefix(sourcePrefix: string, targetPrefix: string): Promise<void>;
  getStream(key: string): Promise<ReadableStream | null>;
}

class S3StorageBackend implements StorageBackend {
  type: StorageType = 's3';
  private client: S3Client | null = null;
  private bucket: string;

  constructor() {
    const { s3 } = config.storage;
    this.bucket = s3.bucket;

    if (s3.endpoint && s3.region && s3.accessKeyId && s3.secretAccessKey) {
      this.client = new S3Client({
        endpoint: s3.endpoint,
        region: s3.region,
        credentials: {
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
        },
        forcePathStyle: true,
      });
    }
  }

  async get(key: string): Promise<Buffer | null> {
    if (!this.client) {
      throw new Error('S3 is not configured');
    }

    try {
      const response = await withTimeout(
        this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
          })
        ),
        30000,
        'S3 get operation timeout'
      );

      if (!response.Body) {
        return null;
      }

      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async put(key: string, body: Buffer | Uint8Array | string, contentType?: string): Promise<void> {
    if (!this.client) {
      throw new Error('S3 is not configured');
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async delete(key: string): Promise<void> {
    if (!this.client) {
      throw new Error('S3 is not configured');
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async getSize(key: string): Promise<number | null> {
    if (!this.client) {
      return null;
    }

    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return response.ContentLength ?? null;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    if (!this.client) {
      return [];
    }

    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            keys.push(obj.Key);
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!this.client) {
      throw new Error('S3 is not configured');
    }

    const BATCH_SIZE = 50;
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const keys =
        response.Contents?.map((obj) => obj.Key).filter((key): key is string => !!key) ?? [];

      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map((key) => this.delete(key)));

        if ((i / BATCH_SIZE) % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  async copyPrefix(sourcePrefix: string, targetPrefix: string): Promise<void> {
    const normalizedSource = sourcePrefix.replace(/\/$/, '');
    const normalizedTarget = targetPrefix.replace(/\/$/, '');
    const BATCH_SIZE = 20;
    let continuationToken: string | undefined;

    do {
      if (!this.client) {
        throw new Error('S3 is not configured');
      }

      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: sourcePrefix,
          ContinuationToken: continuationToken,
        })
      );

      const keys =
        response.Contents?.map((obj) => obj.Key).filter((key): key is string => !!key) ?? [];

      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (key) => {
            const data = await this.get(key);
            if (!data) {
              return;
            }
            const suffix = key.slice(normalizedSource.length);
            const targetKey = `${normalizedTarget}${suffix}`;
            await this.put(targetKey, data);
          })
        );

        if ((i / BATCH_SIZE) % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  async getStream(key: string): Promise<ReadableStream | null> {
    if (!this.client) {
      return null;
    }

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      if (!response.Body) {
        return null;
      }

      return response.Body.transformToWebStream();
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }
}

class LocalStorageBackend implements StorageBackend {
  type: StorageType = 'local';
  private basePath: string;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.basePath = config.storage.localPath;
  }

  private ensureBasePath(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          await stat(this.basePath);
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            await mkdir(this.basePath, { recursive: true });
            return;
          }
          throw error;
        }
      })();
    }
    return this.initPromise;
  }

  private getFullPath(key: string): string {
    return join(this.basePath, key);
  }

  async get(key: string): Promise<Buffer | null> {
    await this.ensureBasePath();
    try {
      const fullPath = this.getFullPath(key);
      const data = await readFile(fullPath);
      return data;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async put(key: string, body: Buffer | Uint8Array | string): Promise<void> {
    await this.ensureBasePath();
    const fullPath = this.getFullPath(key);
    const dir = dirname(fullPath);
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, body);
  }

  async delete(key: string): Promise<void> {
    try {
      const fullPath = this.getFullPath(key);
      await unlink(fullPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const fullPath = this.getFullPath(key);
      await stat(fullPath);
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async getSize(key: string): Promise<number | null> {
    await this.ensureBasePath();
    try {
      const fullPath = this.getFullPath(key);
      const fileStat = await stat(fullPath);
      return fileStat.size;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async *walkLocalKeys(fullPath: string, prefix: string): AsyncGenerator<string> {
    const entries = await readdir(fullPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(fullPath, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        yield* this.walkLocalKeys(entryPath, key);
      } else if (entry.isFile()) {
        yield key;
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureBasePath();
    const fullPath = this.getFullPath(prefix);

    try {
      await stat(fullPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const keys: string[] = [];
    for await (const key of this.walkLocalKeys(fullPath, prefix.replace(/\/$/, ''))) {
      keys.push(key);
      if (keys.length >= MAX_LOCAL_LIST_KEYS) {
        console.warn(`[Storage] local list truncated at ${MAX_LOCAL_LIST_KEYS} keys for prefix ${prefix}`);
        break;
      }
    }

    return keys;
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.ensureBasePath();
    const fullPath = this.getFullPath(prefix);

    try {
      await stat(fullPath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    await rm(fullPath, { recursive: true, force: true });
  }

  async copyPrefix(sourcePrefix: string, targetPrefix: string): Promise<void> {
    await this.ensureBasePath();
    const sourcePath = this.getFullPath(sourcePrefix);

    try {
      await stat(sourcePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    const normalizedSource = sourcePrefix.replace(/\/$/, '');
    const normalizedTarget = targetPrefix.replace(/\/$/, '');
    const BATCH_SIZE = 20;
    let batch: Array<{ sourceKey: string; targetKey: string }> = [];

    const flushBatch = async () => {
      if (batch.length === 0) return;
      const current = batch;
      batch = [];
      await Promise.all(
        current.map(async ({ sourceKey, targetKey }) => {
          const data = await this.get(sourceKey);
          if (data) {
            await this.put(targetKey, data);
          }
        })
      );
    };

    for await (const sourceKey of this.walkLocalKeys(sourcePath, normalizedSource)) {
      const suffix = sourceKey.slice(normalizedSource.length);
      const targetKey = `${normalizedTarget}${suffix}`;
      batch.push({ sourceKey, targetKey });
      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }
    }

    await flushBatch();
  }

  async getStream(key: string): Promise<ReadableStream | null> {
    try {
      const fullPath = this.getFullPath(key);

      return new ReadableStream({
        async start(controller) {
          try {
            const fileHandle = await Bun.file(fullPath);
            const stream = fileHandle.stream();
            const reader = stream.getReader();

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              reader.cancel();
            }

            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

export function getStorageBackend(): StorageBackend {
  const type = config.storage.type;

  switch (type) {
    case 'local':
      return new LocalStorageBackend();
    case 's3':
    default:
      return new S3StorageBackend();
  }
}

export const getRepoPrefix = (owner: string, repo: string): string => {
  return `repos/${owner}/${repo}`;
};

export const getObject = async (key: string): Promise<Buffer | null> => {
  const storage = getStorageBackend();
  return storage.get(key);
};

export const putObject = async (key: string, body: Buffer | Uint8Array | string, contentType?: string): Promise<void> => {
  const storage = getStorageBackend();
  return storage.put(key, body, contentType);
};

export const deleteObject = async (key: string): Promise<void> => {
  const storage = getStorageBackend();
  return storage.delete(key);
};

export const objectExists = async (key: string): Promise<boolean> => {
  const storage = getStorageBackend();
  return storage.exists(key);
};

export const getObjectSize = async (key: string): Promise<number | null> => {
  const storage = getStorageBackend();
  return storage.getSize(key);
};

export const listObjects = async (prefix: string): Promise<string[]> => {
  const storage = getStorageBackend();
  return storage.list(prefix);
};

export const deletePrefix = async (prefix: string): Promise<void> => {
  const storage = getStorageBackend();
  return storage.deletePrefix(prefix);
};

export const copyPrefix = async (sourcePrefix: string, targetPrefix: string): Promise<void> => {
  const storage = getStorageBackend();
  return storage.copyPrefix(sourcePrefix, targetPrefix);
};

export const getObjectStream = async (key: string): Promise<ReadableStream | null> => {
  const storage = getStorageBackend();
  return storage.getStream(key);
};
