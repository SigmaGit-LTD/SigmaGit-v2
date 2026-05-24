import { describe, expect, it } from 'bun:test';
import { resolveRateLimitTier } from '../../middleware/rate-limit';

function mockContext(path: string, method: string, user: { id: string } | null = null) {
  return {
    req: {
      path,
      method,
      header: (name: string) => {
        if (name === 'cookie') return null;
        return null;
      },
    },
    get: (key: string) => (key === 'user' ? user : undefined),
  } as any;
}

describe('resolveRateLimitTier', () => {
  it('excludes health probes', () => {
    expect(resolveRateLimitTier(mockContext('/health', 'GET'))).toBe(null);
    expect(resolveRateLimitTier(mockContext('/api/health', 'GET'))).toBe(null);
  });

  it('uses search tier for GET /api/search', () => {
    expect(resolveRateLimitTier(mockContext('/api/search', 'GET', { id: 'u1' }))).toBe('search');
  });

  it('uses write tier for mutations', () => {
    expect(resolveRateLimitTier(mockContext('/api/repositories', 'POST', { id: 'u1' }))).toBe('write');
  });

  it('uses general tier for authenticated reads', () => {
    expect(resolveRateLimitTier(mockContext('/api/users/me', 'GET', { id: 'u1' }))).toBe('general');
  });

  it('uses unauth tier for anonymous reads', () => {
    expect(resolveRateLimitTier(mockContext('/api/repositories/public', 'GET'))).toBe('unauth');
  });

  it('excludes git protocol paths', () => {
    expect(resolveRateLimitTier(mockContext('/alice/repo.git/info/refs', 'GET'))).toBe(null);
  });
});
