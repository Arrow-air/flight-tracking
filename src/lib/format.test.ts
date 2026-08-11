import { describe, expect, it } from 'vitest';
import { fmtDuration, fromDatetimeLocal } from './format';

describe('fmtDuration', () => {
  it('renders — for null/undefined (empty duration cell, E1)', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
  });

  it('renders MM:SS under an hour and H:MM:SS above', () => {
    expect(fmtDuration(330)).toBe('05:30');
    expect(fmtDuration(3661)).toBe('1:01:01');
  });
});

describe('fromDatetimeLocal', () => {
  it('empty input → null (F3: started is optional)', () => {
    expect(fromDatetimeLocal('')).toBeNull();
    expect(fromDatetimeLocal(null)).toBeNull();
    expect(fromDatetimeLocal(undefined)).toBeNull();
  });

  it('garbage input → null, valid input → ISO', () => {
    expect(fromDatetimeLocal('not-a-date')).toBeNull();
    expect(fromDatetimeLocal('2026-08-11T10:00')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
