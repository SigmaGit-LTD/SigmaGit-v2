import { deflate, gzip, inflate, inflateRaw } from 'node:zlib/promises';

export { deflate, gzip, inflate, inflateRaw };

/**
 * Decompress zlib or raw-deflate data and estimate how many input bytes were consumed.
 */
export async function inflateWithConsumedBytes(
  buf: Buffer,
  offset: number
): Promise<{ data: Buffer; bytesRead: number }> {
  const remaining = buf.subarray(offset);

  const findConsumed = async (raw: boolean): Promise<{ data: Buffer; bytesRead: number } | null> => {
    const inflateFn = raw ? inflateRaw : inflate;

    try {
      const result = await inflateFn(remaining);

      let consumed = 0;
      let low = raw ? 1 : 2;
      let high = remaining.length;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        try {
          await inflateFn(remaining.subarray(0, mid));
          consumed = mid;
          high = mid - 1;
        } catch {
          low = mid + 1;
        }
      }

      return { data: result, bytesRead: consumed || remaining.length };
    } catch {
      return null;
    }
  };

  const zlibResult = await findConsumed(false);
  if (zlibResult) return zlibResult;

  const rawResult = await findConsumed(true);
  if (rawResult) return rawResult;

  throw new Error(`Failed to inflate at offset ${offset}`);
}
