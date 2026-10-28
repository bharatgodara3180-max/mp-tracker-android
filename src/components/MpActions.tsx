import { useState } from 'react';
import { rpc, requestId } from '../lib/api';
import type { AppRole, MpLive } from '../lib/types';
import { parseItems, ITEM_TYPES } from '../lib/items';
import { Button, Field, Modal, useAction, useToast, ErrorBox } from './ui';
import type { RefData } from '../hooks/useRefData';

export type MpActionKind = 'assign' | 'unassign' | 'break_start' | 'break_end' | 'pickup' | 'handover'
  | 'correction' | 'override' | 'cancel_pickup';

export const ACTION_LABEL: Record<MpActionKind, string> = {
  assign: 'Assign / transfer area', unassign: 'Unassign', break_start: 'Start break', break_end: 'End break',
  pickup: 'Plan pickup / external duty', handover: 'Raise handover', correction: 'Gate correction',
  override: 'Override status', cancel_pickup: 'Cancel planned pickup',
};

/** Which actions make sense for this MP right now, for this role. Server re-validates everything. */
export function availableActions(row: MpLive, role: AppRole | undefined): MpActionKind[] {
  if (!role || role === 'mp' || role === 'ops_manager') return [];   // ops_manager: view only
  if (role === 'gate_operator') return ['correction'];
  const a: MpActionKind[] = [];
  const s = row.status;
  if (['INSIDE_UNASSIGNED', 'WORKING', 'HANDOVER_DISPUTED'].includes(s)) a.push('assign');
  if (s === 'WORKING') a.push('unassign');
  if (['INSIDE_UNASSIGNED', 'WORKING'].includes(s)) a.push('break_start', 'handover');
  if (s === 'ON_BREAK') a.push('break_end');
  if (row.presence === 'INSIDE' && !['HANDOVER_PENDING', 'HANDOVER_IN_PROGRESS'].includes(s) && row.pickup_status !== 'PLANNED') a.push('pickup');
  if (row.pickup_status === 'PLANNED') a.push('cancel_pickup');
  a.push('correction', 'override');
  return a;
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function MpActionModal({ kind, row, refData, onClose, onDone }:
  { kind: MpActionKind; row: MpLive; refData: RefData; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string | boolean>>({
    area_id: row.area_id ?? '', task: row.current_task ?? '', process: '', supervisor: '',
    break_type: 'LUNCH', purpose: 'PICKUP', destination: '', route_ref: '', client_name: '',
    expected_return: toLocalInput(new Date(Date.now() + 2 * 3600_000)), handover_required: true,
    receiving_area: refData.activeAreas.find((a) => a.receives_handover)?.id ?? '', next_area: '', notes: '',
    depart_now: false, ho_type: 'DOCK', dest_area: refData.activeAreas.find((a) => a.kind === 'DOCK')?.id ?? '',
    items: '', item_default: 'SHIPMENT', remarks: '', direction: row.presence === 'INSIDE' ? 'OUT' : 'IN',
    event_time: toLocalInput(new Date()), gate_purpose: '', reason: '', target: 'INSIDE_UNASSIGNED',
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  const v = (k: string) => String(f[k] ?? '');
  const base = { p_employee_id: row.employee_id, p_expected_version: row.version };

  async function submit() {
    setErr(null);
    let call: () => Promise<unknown>;
    let ok = 'Saved';
    switch (kind) {
      case 'assign':
        if (!v('area_id')) return setErr('Choose a work area');
        call = () => rpc('assign_work', { ...base, p_area_id: v('area_id'), p_task: v('task') || null,
          p_process: v('process') || null, p_supervisor_user_id: v('supervisor') || null, p_reason: v('reason') || null,
          p_client_request_id: requestId() });
        ok = row.status === 'WORKING' ? 'Transfer recorded' : 'Assigned';
        break;
      case 'unassign':
        call = () => rpc('unassign_work', { ...base, p_reason: v('reason') || null, p_client_request_id: requestId() });
        break;
      case 'break_start':
        call = () => rpc('start_break', { ...base, p_break_type: v('break_type'), p_client_request_id: requestId() });
        ok = 'Break started';
        break;
      case 'break_end':
        call = () => rpc('end_break', { ...base, p_client_request_id: requestId() });
        ok = 'Break ended';
        break;
      case 'pickup':
        if (v('purpose') === 'PICKUP' && !v('destination') && !v('route_ref')) return setErr('Enter a destination or route/reference');
        call = () => rpc('plan_pickup', { ...base, p_purpose: v('purpose'), p_destination: v('destination') || null,
          p_route_ref: v('route_ref') || null, p_client_name: v('client_name') || null,
          p_expected_return_at: v('expected_return') ? new Date(v('expected_return')).toISOString() : null,
          p_handover_required: !!f.handover_required, p_receiving_area_id: v('receiving_area') || null,
          p_next_area_id: v('next_area') || null, p_notes: v('notes') || null, p_depart_now: !!f.depart_now,
          p_client_request_id: requestId() });
        ok = f.depart_now ? 'Departure recorded' : 'Pickup planned — status changes when the gate records OUT';
        break;
      case 'cancel_pickup':
        if (!row.pickup_id) return;
        if (v('reason').trim().length < 3) return setErr('Reason required');
        call = () => rpc('cancel_pickup', { p_pickup_id: row.pickup_id, p_reason: v('reason') });
        break;
      case 'handover': {
        const { items, errors } = parseItems(v('items'), v('item_default') as never);
        if (errors.length) return setErr(errors.join('\n'));
        call = () => rpc('create_handover', { ...base, p_handover_type: v('ho_type'), p_destination_area_id: v('dest_area') || null,
          p_items: items, p_remarks: v('remarks') || null, p_client_request_id: requestId() });
        ok = 'Handover raised — waiting for receiver';
        break;
      }
      case 'correction':
        if (v('reason').trim().length < 5) return setErr('A reason of at least 5 characters is mandatory');
        call = () => rpc('manual_gate_correction', { p_employee_id: row.employee_id, p_direction: v('direction'),
          p_reason: v('reason'), p_event_time: new Date(v('event_time')).toISOString(),
          p_purpose: v('direction') === 'OUT' && v('gate_purpose') ? v('gate_purpose') : null,
          p_client_request_id: requestId() });
        ok = 'Correction recorded';
        break;
      case 'override':
        if (v('reason').trim().length < 5) return setErr('A reason of at least 5 characters is mandatory');
        call = () => rpc('override_mp_state', { ...base, p_target: v('target'), p_reason: v('reason') });
        ok = 'Override recorded';
        break;
    }
    const r = await run(call!, ok) as { pending_approval?: boolean } | undefined;
    if (r) {
      if (r.pending_approval) toast('ok', 'Submitted for Operations Manager approval.');
      onDone(); onClose();
    }
  }

  const areaOptions = refData.workAreas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>);

  return (
    <Modal title={`${ACTION_LABEL[kind]} — ${row.full_name} (${row.employee_code})`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={kind === 'override' || kind === 'correction' ? 'danger' : 'primary'} busy={busy} onClick={submit}>Confirm</Button></>}>
      <ErrorBox error={err} />
      {kind === 'assign' && <>
        <Field label="Work area / block"><select value={v('area_id')} onChange={set('area_id')}><option value="">Select…</option>{areaOptions}</select></Field>
        <div className="grid2">
          <Field label="Task"><input value={v('task')} onChange={set('task')} placeholder="e.g. Induction, Loading" /></Field>
          <Field label="Process"><input value={v('process')} onChange={set('process')} placeholder="optional" /></Field>
        </div>
        <Field label="Supervisor"><select value={v('supervisor')} onChange={set('supervisor')}>
          <option value="">MP's default supervisor</option>
          {refData.supervisors.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}</select></Field>
        {row.status === 'WORKING' && <Field label="Transfer reason"><input value={v('reason')} onChange={set('reason')} placeholder="optional" /></Field>}
      </>}
      {kind === 'unassign' && <Field label="Reason"><input value={v('reason')} onChange={set('reason')} placeholder="optional" /></Field>}
      {kind === 'break_start' && <Field label="Break type"><select value={v('break_type')} onChange={set('break_type')}>
        <option value="LUNCH">Lunch</option><option value="TEA">Tea</option><option value="OTHER">Other</option></select></Field>}
      {kind === 'break_end' && <p>End the break now? The MP returns to their previous area if configured.</p>}
      {kind === 'pickup' && <>
        <div className="grid2">
          <Field label="Purpose"><select value={v('purpose')} onChange={set('purpose')}>
            <option value="PICKUP">Pickup</option><option value="OFFICIAL">Official work</option><option value="OTHER">Other</option></select></Field>
          <Field label="Expected return"><input type="datetime-local" value={v('expected_return')} onChange={set('expected_return')} /></Field>
        </div>
        <Field label="Destination"><input value={v('destination')} onChange={set('destination')} placeholder="Seller / location" /></Field>
        <div className="grid2">
          <Field label="Route / reference no."><input value={v('route_ref')} onChange={set('route_ref')} /></Field>
          <Field label="Client"><input value={v('client_name')} onChange={set('client_name')} /></Field>
        </div>
        {v('purpose') === 'PICKUP' && <label className="check"><input type="checkbox" checked={!!f.handover_required} onChange={set('handover_required')} /> Handover required on return</label>}
        <div className="grid2">
          <Field label="Receiving area"><select value={v('receiving_area')} onChange={set('receiving_area')}><option value="">—</option>{areaOptions}</select></Field>
          <Field label="Next assignment after return"><select value={v('next_area')} onChange={set('next_area')}><option value="">Unassigned</option>{areaOptions}</select></Field>
        </div>
        <Field label="Notes"><input value={v('notes')} onChange={set('notes')} /></Field>
        <label className="check"><input type="checkbox" checked={!!f.depart_now} onChange={set('depart_now')} /> Record departure now (no working gate device)</label>
      </>}
      {kind === 'cancel_pickup' && <Field label="Reason"><input value={v('reason')} onChange={set('reason')} /></Field>}
      {kind === 'handover' && <>
        <div className="grid2">
          <Field label="Handover type"><select value={v('ho_type')} onChange={set('ho_type')}>
            {['DOCK', 'PRIMARY', 'SECONDARY', 'STAGING', 'OTHER'].map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Receiving area"><select value={v('dest_area')} onChange={set('dest_area')}><option value="">—</option>{areaOptions}</select></Field>
        </div>
        <div className="grid2">
          <Field label="Items" hint="One per line: TYPE, reference, qty — or just scan references">
            <textarea rows={5} value={v('items')} onChange={set('items')} placeholder={'BAG, BAG-0091, 1\nMNF-55120'} /></Field>
          <Field label="Default item type"><select value={v('item_default')} onChange={set('item_default')}>
            {ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        </div>
        <Field label="Remarks"><input value={v('remarks')} onChange={set('remarks')} /></Field>
      </>}
      {kind === 'correction' && <>
        <p className="muted">Adds a missing gate event. It is stored as a CORRECTION, never overwrites history, and is audited.</p>
        <div className="grid2">
          <Field label="Direction"><select value={v('direction')} onChange={set('direction')}><option>IN</option><option>OUT</option></select></Field>
          <Field label="Actual time"><input type="datetime-local" value={v('event_time')} onChange={set('event_time')} /></Field>
        </div>
        {v('direction') === 'OUT' && <Field label="Exit purpose"><select value={v('gate_purpose')} onChange={set('gate_purpose')}>
          <option value="">Use planned / infer</option>{['PICKUP', 'LUNCH', 'BREAK', 'OFFICIAL', 'SHIFT_END', 'OTHER'].map((p) => <option key={p}>{p}</option>)}</select></Field>}
        <Field label="Reason (mandatory)"><textarea rows={2} value={v('reason')} onChange={set('reason')} placeholder="e.g. Face tablet offline 06:00–06:20, verified by TL" /></Field>
      </>}
      {kind === 'override' && <>
        <p className="muted">Closes open work/break periods and sets the status. Pending handovers are NOT completed. Audited.</p>
        <Field label="Set status to"><select value={v('target')} onChange={set('target')}>
          <option value="INSIDE_UNASSIGNED">Inside · Unassigned</option><option value="SHIFT_ENDED">Shift ended (checked out)</option></select></Field>
        <Field label="Reason (mandatory)"><textarea rows={2} value={v('reason')} onChange={set('reason')} /></Field>
      </>}
    </Modal>
  );
}
