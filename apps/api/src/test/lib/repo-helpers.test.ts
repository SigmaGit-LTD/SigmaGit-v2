import { describe, expect, it } from 'bun:test';
import { getStorageOwnerId } from '../../lib/repo-helpers';

describe('getStorageOwnerId', () => {
  it('returns ownerId for user-owned repos', () => {
    expect(getStorageOwnerId({ ownerId: 'user-1', organizationId: null })).toBe('user-1');
  });

  it('returns organizationId for org-owned repos', () => {
    expect(getStorageOwnerId({ ownerId: 'user-1', organizationId: 'org-1' })).toBe('org-1');
  });
});
