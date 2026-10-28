import { describe, expect, it } from 'vitest';
import { isLocalhostServer, normalizeServer, parseGateLink } from './native';

describe('android app setup', () => {
  it('normalizes server addresses', () => {
    expect(normalizeServer('192.168.1.20:8010')).toBe('http://192.168.1.20:8010/');
    expect(normalizeServer('https://abc.ngrok-free.dev/MP')).toBe('https://abc.ngrok-free.dev/MP/');
    expect(normalizeServer('https://abc.ngrok-free.dev/MP/')).toBe('https://abc.ngrok-free.dev/MP/');
    expect(normalizeServer('http://x:8010/index.html')).toBe('http://x:8010/');
    expect(normalizeServer('')).toBeNull();
  });
  it('reads the gate link', () => {
    expect(parseGateLink('https://abc.ngrok-free.dev/MP/#/dc-gate?d=gate-face-tab-01&k=AbC_12-x')).toEqual(
      { server: 'https://abc.ngrok-free.dev/MP/', device: 'GATE-FACE-TAB-01', key: 'AbC_12-x' });
    expect(parseGateLink('http://localhost:8010/#/dc-gate?d=G1&k=K')?.server).toBe('http://localhost:8010/');
    expect(isLocalhostServer('http://localhost:8010/')).toBe(true);
    expect(parseGateLink('hello')).toBeNull();
  });
});
