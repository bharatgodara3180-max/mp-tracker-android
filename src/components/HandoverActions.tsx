import { useEffect, useMemo, useState } from 'react';
import { get, rpc, requestId } from '../lib/api';
import type { HandoverItem, HandoverLive, MpLive } from '../lib/types';
import { parseItems, ITEM_TYPES } from '../lib/items';
import { Button, ErrorBox, Field, Modal, useAction } from './ui';

export type HoActionKind = 'accept' | 'start' | 'dispute' | 'verify' | 'resolve' | 'cancel' | 'items' | 'reason';
export const HO_ACTION_LABEL: Record<HoActionKind, string> = {
  accept: 'Receive & accept', start: 'Start receiving', dispute: 'Dispute', verify: 'Verify (supervisor)',
  resolve: 'Resolve dispute', cancel: 'Cancel handover', items: 'Add items', reason: 'Pending reason',
};

export function hoActions(h: HandoverLive, isSupervisor: boolean): HoActionKind[] {
  const a: HoActionKind[] = [];
  if (h.status === 'PENDING') a.push('accept', 'start', 'dispute', 'items', 'reason');
  if (h.status === 'IN_PROGRESS' && !h.awaiting_verification) a.push('accept', 'dispute', 'items', 'reason');
  if (h.awaiting_verification && isSupervisor) a.push('verify');
  if (h.status === 'DISPUTED' && isSupervisor) a.push('resolve');
  if (['PENDING', 'IN_PROGRESS', 'DISPUTED'].includes(h.status) && isSupervisor) a.push('cancel');
  return a;
}

/** Receiver picker: scan a badge / type an ID, or choose from on-duty MPs inside the DC. */
export function ReceiverPicker({ value, onChange, exclude, fixedEmployeeId }:
  { value: string; onChange: (id: string) => void; exclude?: string; fixedEmployeeId?: string | null }) {
  const [list, setList] = useState<Pick<MpLive, 'employee_id' | 'employee_code' | 'full_name' | 'area_name' | 'status'>[]>([]);
  const [scan, setScan] = useState('');
  useEffect(() => {
    if (fixedEmployeeId) return;
    get<typeof list>('receivers').then(setList).catch(() => setList([]));
  }, [fixedEmployeeId]);
  const opts = useMemo(() => list.filter((x) => x.employee_id !== exclude), [list, exclude]);
  if (fixedEmployeeId) return <p className="muted">Receiving as yourself.</p>;
  return (
    <>
      <Field label="Scan receiver badge / type employee ID">
        <input autoFocus value={scan} placeholder="Scan or type…" onChange={(e) => {
          setScan(e.target.value);
          const m = opts.find((o) => o.employee_code.toLowerCase() === e.target.value.trim().toLowerCase());
          if (m) onChange(m.employee_id);
        }} />
      </Field>
      <Field label="Receiving MP (inside & on duty)">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {opts.map((o) => <option key={o.employee_id} value={o.employee_id}>{o.full_name} · {o.employee_code}{o.area_name ? ` · ${o.area_name}` : ''}</option>)}
        </select>
      </Field>
    </>
  );
}

export function HandoverActionModal({ kind, h, onClose, onDone, selfEmployeeId }:
  { kind: HoActionKind; h: HandoverLive; onClose: () => void; onDone: () => void; selfEmployeeId?: string | null }) {
  const { busy, run } = useAction();
  const [receiver, setReceiver] = useState(selfEmployeeId ?? (h.mode === 'ONE_TO_ONE' ? h.received_by_employee_id ?? '' : ''));
  const [items, setItems] = useState<HandoverItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [itemType, setItemType] = useState('SHIPMENT');
  const [note, setNote] = useState(kind === 'reason' ? h.pending_reason ?? '' : '');
  const [accept, setAccept] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<HandoverItem[]>(`handovers/${h.id}/items`)
      .then((it) => { setItems(it); setPicked(new Set(it.filter((i) => i.status === 'PENDING').map((i) => i.id))); })
      .catch(() => setItems([]));
  }, [h.id]);

  const pending = items.filter((i) => i.status === 'PENDING');
  const needsReceiver = ['accept', 'start', 'dispute'].includes(kind);

  async function submit() {
    setErr(null);
    if (needsReceiver && !receiver) return setErr('Select or scan the receiving MP');
    let call: () => Promise<unknown>; let ok = 'Saved';
    switch (kind) {
      case 'accept':
        if (pending.length && picked.size === 0) return setErr('Tick the items being accepted');
        call = () => rpc('accept_handover', { p_handover_id: h.id, p_receiver_employee_id: receiver,
          p_item_ids: pending.length && picked.size < pending.length ? [...picked] : null,
          p_remarks: note || null, p_client_request_id: requestId() });
        ok = 'Acceptance recorded';
        break;
      case 'start':
        call = () => rpc('start_handover', { p_handover_id: h.id, p_receiver_employee_id: receiver, p_client_request_id: requestId() });
        ok = 'Handover started';
        break;
      case 'dispute':
        if (note.trim().length < 3) return setErr('Describe the discrepancy');
        call = () => rpc('dispute_handover', { p_handover_id: h.id, p_receiver_employee_id: receiver, p_remarks: note,
          p_item_ids: pending.length && picked.size && picked.size < pending.length ? [...picked] : null });
        ok = 'Dispute raised — supervisor notified';
        break;
      case 'verify':
        call = () => rpc('verify_handover', { p_handover_id: h.id, p_note: note || null });
        ok = 'Verified and completed';
        break;
      case 'resolve':
        if (note.trim().length < 3) return setErr('Resolution note required');
        call = () => rpc('resolve_handover_dispute', { p_handover_id: h.id, p_accept: accept, p_note: note });
        break;
      case 'cancel':
        if (note.trim().length < 5) return setErr('Reason (min 5 characters) required');
        call = () => rpc('cancel_handover', { p_handover_id: h.id, p_reason: note });
        break;
      case 'items': {
        const r = parseItems(text, itemType as never);
        if (r.errors.length) return setErr(r.errors.join('\n'));
        if (!r.items.length) return setErr('Enter at least one item');
        call = () => rpc('add_handover_items', { p_handover_id: h.id, p_items: r.items });
        break;
      }
      case 'reason':
        call = () => rpc('set_handover_pending_reason', { p_handover_id: h.id, p_reason: note });
        break;
    }
    const r = await run(call!, ok);
    if (r) { onDone(); onClose(); }
  }

  return (
    <Modal title={`${HO_ACTION_LABEL[kind]} — #${h.handover_no} ${h.handing_name}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant={kind === 'dispute' || kind === 'cancel' ? 'danger' : 'primary'} busy={busy} onClick={submit}>Confirm</Button></>}>
      <ErrorBox error={err} />
      <p className="muted small">{h.handover_type.replace('_', ' ')} · {h.mode === 'ONE_TO_MANY' ? 'one-to-many' : 'one-to-one'}
        {h.route_ref ? ` · route ${h.route_ref}` : ''}{h.destination_area_name ? ` · to ${h.destination_area_name}` : ''}</p>
      {needsReceiver && <ReceiverPicker value={receiver} onChange={setReceiver} exclude={h.handing_employee_id} fixedEmployeeId={selfEmployeeId} />}
      {(kind === 'accept' || kind === 'dispute') && items.length > 0 && (
        <div className="items-box">
          <div className="items-head">Items ({items.filter((i) => i.status === 'ACCEPTED').length}/{items.length} accepted)</div>
          {items.map((i) => (
            <label key={i.id} className={`item-row st-${i.status.toLowerCase()}`}>
              <input type="checkbox" disabled={i.status !== 'PENDING'} checked={picked.has(i.id)}
                onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
              <span className="mono">{i.item_type}</span> {i.reference} × {i.quantity}
              {i.status !== 'PENDING' ? <span className="muted"> · {i.status}</span> : null}
            </label>))}
        </div>)}
      {kind === 'accept' && <p className="small">Accepting confirms you have physically received the {items.length ? 'ticked items' : 'responsibility/task'} from <strong>{h.handing_name}</strong>. Short or damaged? Use <em>Dispute</em> instead.</p>}
      {kind === 'items' && <div className="grid2">
        <Field label="Items" hint="One per line: TYPE, reference, qty — or scan references"><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <Field label="Default type"><select value={itemType} onChange={(e) => setItemType(e.target.value)}>{ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
      </div>}
      {kind === 'resolve' && <div className="row gap">
        <label className="check"><input type="radio" checked={accept} onChange={() => setAccept(true)} /> Accept (mark completed)</label>
        <label className="check"><input type="radio" checked={!accept} onChange={() => setAccept(false)} /> Reject</label>
      </div>}
      {['accept', 'dispute', 'verify', 'resolve', 'cancel', 'reason'].includes(kind) &&
        <Field label={kind === 'dispute' ? 'Discrepancy remarks (required)' : kind === 'cancel' ? 'Reason (required)' : kind === 'reason' ? 'Why is it pending?' : 'Remarks'}>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>}
    </Modal>
  );
}
