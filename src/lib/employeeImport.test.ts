import { describe, expect, it } from 'vitest';
import { mapHeaders, prepareRows } from './employeeImport';

describe('employee file import', () => {
  it('matches friendly headers', () => {
    expect(mapHeaders(['Emp ID', 'Name', 'Shift Timing', 'QR Code'])).toEqual({
      employee_code: 'Emp ID', full_name: 'Name', shift_code: 'Shift Timing', badge_code: 'QR Code' });
  });
  it('cleans rows and reports problems with Excel line numbers', () => {
    const r = prepareRows([
      { 'Employee Code': 'emp1 ', Name: 'Ramesh', Shift: '09:00-18:00' },
      { 'Employee Code': 1002, Name: 'Sunita', Shift: '' },
      { 'Employee Code': '', Name: 'No Code' },
      { 'Employee Code': 'EMP1', Name: 'Dup' },
      { 'Employee Code': 'EMP3', Name: 'Bad shift', Shift: 'subah wali' },
      { 'Employee Code': '', Name: '' },
    ]);
    expect(r.rows.map((x) => [x.employee_code, x.shift_code])).toEqual([['EMP1', '09:00-18:00'], ['1002', '']]);
    expect(r.issues.map((i) => i.line)).toEqual([4, 5, 6]);
  });
  it('accepts existing shift codes only', () => {
    const r = prepareRows([{ Code: 'A1', Name: 'x', Shift: 's1' }, { Code: 'A2', Name: 'y', Shift: 'morning' }], ['S1']);
    expect(r.rows.map((x) => x.employee_code)).toEqual(['A1']);
    expect(r.issues[0].line).toBe(3);
  });
  it('needs code and name columns', () => {
    expect(prepareRows([{ Foo: 1 }]).missingColumns).toEqual(['employee_code', 'full_name']);
  });
});
