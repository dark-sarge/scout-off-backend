import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageSize } from '../../src/utils/pagination';

describe('pagination constants', () => {
  it('exports the default and max page size constants', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});

describe('clampPageSize', () => {
  it('returns the default size for undefined and non-numeric values', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize('abc')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize('NaN')).toBe(DEFAULT_PAGE_SIZE);
  });

  it('enforces the minimum page size', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-12)).toBe(1);
    expect(clampPageSize('-7')).toBe(1);
  });

  it('normalizes fractional values by truncating to integer input', () => {
    expect(clampPageSize(2.9)).toBe(2);
    expect(clampPageSize('12.8')).toBe(12);
  });

  it('caps values at the maximum page size', () => {
    expect(clampPageSize(999)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize('5000')).toBe(MAX_PAGE_SIZE);
  });

  it('accepts valid in-range values unchanged', () => {
    expect(clampPageSize(1)).toBe(1);
    expect(clampPageSize(10)).toBe(10);
    expect(clampPageSize(50)).toBe(50);
    expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
  });
});
