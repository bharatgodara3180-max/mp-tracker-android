import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, onUnauthorized, post, token } from '../lib/api';
import type { AppRole, Profile } from '../lib/types';

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

  const signOut = useCallback(() => { token.set(null); setProfile(null); }, []);

  useEffect(() => {
    const off = onUnauthorized(() => { token.set(null); setProfile(null); });
    if (!token.get()) { setLoading(false); return () => { off(); }; }
    get<MeResponse>('auth/me').then((u) => setProfile(toProfile(u)))
      .catch((e) => { if (e?.status !== 401) setError(e.message); token.set(null); })
      .finally(() => setLoading(false));
    return () => { off(); };
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
