import { describe, it, expect } from 'vitest';
import { compareNames } from '../src/tools/compare_names';
import { parseCsv } from '../src/services/ingest';

describe('compareNames', () => {
  it('is case-insensitive', () => {
    expect(compareNames('Acme Corp', 'ACME CORP').similarity).toBe(1);
  });

  it('scores a name variant above an unrelated name', () => {
    const variant = compareNames('Sharma Electronics Pvt Ltd', 'Sharma Electronics').similarity;
    const other = compareNames('Sharma Electronics Pvt Ltd', 'Thakur Rice Mills').similarity;
    expect(variant).toBeGreaterThan(other);
  });
});

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes and CRLF', () => {
    const rows = parseCsv('id,name\r\n1,"Rathore Sand, Gravel"\r\n2,"Say ""hi"""\r\n');
    expect(rows).toEqual([
      { id: '1', name: 'Rathore Sand, Gravel' },
      { id: '2', name: 'Say "hi"' },
    ]);
  });
});
