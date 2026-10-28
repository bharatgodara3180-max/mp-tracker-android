import { get } from '../lib/api';
import type { Area, Shift } from '../lib/types';
import { useLiveQuery } from './useLive';

export interface StaffUser { user_id: string; full_name: string; role: string }

export interface RefData {
  areas: Area[];
  activeAreas: Area[];
  workAreas: Area[];     // active areas MPs work in
  outOptions: Area[];    // active OUT options (Lunch / Pickup / Other…)
  shifts: Shift[];
  supervisors: StaffUser[];
}

export function useRefData() {
  const q = useLiveQuery<RefData>(async () => {
    const r = await get<{ areas: Area[]; shifts: Shift[]; supervisors: StaffUser[] }>('ref');
    const areas = r.areas.map((a) => ({ ...a, is_active: !!a.is_active, receives_handover: !!a.receives_handover }));
    const activeAreas = areas.filter((a) => a.is_active);
    return { areas, activeAreas, workAreas: activeAreas.filter((a) => !a.out_purpose), outOptions: activeAreas.filter((a) => !!a.out_purpose), shifts: r.shifts.map((s) => ({ ...s, is_active: !!s.is_active })), supervisors: r.supervisors };
  }, [], [], { pollMs: 300_000 });
  return { ...(q.data ?? { areas: [], activeAreas: [], workAreas: [], outOptions: [], shifts: [], supervisors: [] }), loading: q.loading, error: q.error };
}
