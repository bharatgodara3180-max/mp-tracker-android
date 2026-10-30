import { describe, expect, it } from 'vitest';
import { isLocalhostServer, isMpLink, normalizeLink, normalizeServer, parseGateLink } from './native';

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

describe('SFXBM link entry', () => {
  it('normalizes typed links', () => {
    expect(normalizeLink('abc.ngrok-free.dev/ASSETS')).toBe('https://abc.ngrok-free.dev/ASSETS');
    expect(normalizeLink('192.168.1.5:8060/ASSETS/')).toBe('http://192.168.1.5:8060/ASSETS/');
    expect(normalizeLink('10.10.39.55:8010')).toBe('http://10.10.39.55:8010/');
    expect(normalizeLink('hello')).toBeNull();
    expect(normalizeLink('two words.com')).toBeNull();
    expect(normalizeLink('')).toBeNull();
  });
  it('MP links stay in the built-in screens, others open as they are', () => {
    expect(isMpLink('http://10.10.39.55:8010/')).toBe(true);
    expect(isMpLink('https://abc.ngrok-free.dev/MP/')).toBe(true);
    expect(isMpLink('https://abc.ngrok-free.dev/')).toBe(true);
    expect(isMpLink('https://abc.ngrok-free.dev/mp/#/dc-gate?d=G&k=K')).toBe(true);
    expect(isMpLink('https://abc.ngrok-free.dev/ASSETS/')).toBe(false);
    expect(isMpLink('https://abc.ngrok-free.dev/ASSETS/admin')).toBe(false);
    expect(isMpLink('http://10.10.39.55:8030/')).toBe(false);
  });
});
