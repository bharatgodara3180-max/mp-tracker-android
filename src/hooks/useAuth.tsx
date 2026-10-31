import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, onUnauthorized, post, token } from '../lib/api';
import type { AppRole, Profile } from '../lib/types';
import { isNativeApp, openLinkNow, sfxbmLoginUrl } from '../lib/native';

interface AuthCtx {
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  can: (...roles: AppRole[]) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

interface MeResponse { id: string; username: string; full_name: string; role: AppRole; employee_id: string | null; is_active: boolean }
const toProfile = (u: MeResponse): Profile => ({ user_id: u.id, full_name: u.full_name, role: u.role, employee_id: u.employee_id, is_active: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const signOut = useCallback(() => { token.set(null); setProfile(null); const to = sfxbmLoginUrl(); if (to) { if (isNativeApp()) openLinkNow(to); else window.location.replace(to); } }, []);

  useEffect(() => {
    const off = onUnauthorized(() => { token.set(null); setProfile(null); });
    if (!token.get()) { setLoading(false); return () => { off(); }; }
    let alive = true;
    const load = async () => {
      for (let i = 0; alive; i++) {
        try { const u = await get<MeResponse>('auth/me'); if (alive) setProfile(toProfile(u)); break; }
        catch (e) {
          // only a real "sign in again" clears the login; server busy / network = keep it and retry
          if ((e as { code?: string })?.code === 'UNAUTHENTICATED' || (e as { status?: number })?.status === 403) { token.set(null); break; }
          if (i >= 4) { setError((e as Error).message); break; }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (alive) setLoading(false);
    };
    void load();
    const stop = () => { alive = false; };
    return () => { stop(); off(); };
  }, []);

  const signIn = async (username: string, password: string) => {
    const r = await post<{ token: string; user: MeResponse }>('auth/login', { username, password });
    token.set(r.token);
    setError(null);
    setProfile(toProfile({ ...r.user, is_active: true }));
  };

  const can = (...roles: AppRole[]) => !!profile && roles.includes(profile.role);
  return <Ctx.Provider value={{ profile, loading, error, can, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
