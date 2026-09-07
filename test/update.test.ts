import { describe, expect, it } from 'vitest';
import { isNewer } from '../src/update.js';

describe('isNewer', () => {
  it('compares numerically, not as strings', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
  });

  it('treats the same version as no update', () => {
    expect(isNewer('0.8.1', '0.8.1')).toBe(false);
  });

  it('ignores prerelease and build tags', () => {
    expect(isNewer('0.8.1-beta.2', '0.8.1')).toBe(false);
    expect(isNewer('0.9.0-rc.1', '0.8.1')).toBe(true);
  });

  it('tolerates a leading v and missing segments', () => {
    expect(isNewer('v1.0', '0.8.1')).toBe(true);
    expect(isNewer('0.8', '0.8.1')).toBe(false);
  });
});
