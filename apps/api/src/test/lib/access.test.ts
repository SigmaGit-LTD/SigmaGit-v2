import { describe, expect, it } from 'bun:test';

describe('access permission helpers', () => {
  it('write permission requires write or admin', () => {
    const hasWrite = (permission: string) => permission === 'write' || permission === 'admin';
    expect(hasWrite('read')).toBe(false);
    expect(hasWrite('write')).toBe(true);
    expect(hasWrite('admin')).toBe(true);
  });
});
