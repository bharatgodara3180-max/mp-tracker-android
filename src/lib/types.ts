export type AppRole = 'admin' | 'ops_manager' | 'supervisor' | 'mp' | 'gate_operator';

export type MpStatus =
  | 'NOT_CHECKED_IN' | 'INSIDE_UNASSIGNED' | 'WORKING' | 'ON_BREAK'
  | 'OUTSIDE_PICKUP' | 'OUTSIDE_OFFICIAL' | 'OUTSIDE_BREAK' | 'OUTSIDE_OTHER' | 'OUTSIDE_UNDECLARED'
  | 'HANDOVER_PENDING' | 'HANDOVER_IN_PROGRESS' | 'HANDOVER_DISPUTED' | 'SHIFT_ENDED';

export type Presence = 'INSIDE' | 'OUTSIDE' | 'UNKNOWN';
export type HandoverStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'DISPUTED' | 'REJECTED' | 'CANCELLED';
export type HandoverType = 'PICKUP_RETURN' | 'DOCK' | 'PRIMARY' | 'SECONDARY' | 'STAGING' | 'OTHER';
export type ExitPurpose = 'PICKUP' | 'LUNCH' | 'BREAK' | 'OFFICIAL' | 'SHIFT_END' | 'OTHER';
export type AreaKind = 'PRIMARY' | 'SECONDARY' | 'STAGING' | 'DOCK' | 'BLOCK' | 'OTHER';

export interface Profile {
  user_id: string;
  full_name: string;
  role: AppRole;
  employee_id: string | null;
  is_active: boolean;
}

export interface MpLive {
  employee_id: string;
  employee_code: string;
  full_name: string;
  designation: string | null;
  is_demo: boolean;
  status: MpStatus;
  presence: Presence;
  status_since: string;
  version: number;
  updated_at: string;
  shift_id: string | null;
  shift_code: string | null;
  shift_name: string | null;
  attendance_id: string | null;
  checked_in_at: string | null;
  assignment_id: string | null;
  area_id: string | null;
  area_code: string | null;
  area_name: string | null;
  area_kind: AreaKind | null;
  current_task: string | null;
  supervisor_user_id: string | null;
  supervisor_name: string | null;
  pickup_id: string | null;
  pickup_status: 'PLANNED' | 'OUT' | null;
  pickup_purpose: ExitPurpose | null;
  route_ref: string | null;
  pickup_destination: string | null;
  departed_at: string | null;
  expected_return_at: string | null;
  break_id: string | null;
  break_type: string | null;
  break_location: Presence | null;
  break_started_at: string | null;
  break_allowed_minutes: number | null;
  handover_id: string | null;
  handover_no: number | null;
  handover_status: HandoverStatus | null;
  handover_type: HandoverType | null;
  handover_pending_since: string | null;
  handover_due_at: string | null;
  handover_completed_at: string | null;
  received_by_employee_id: string | null;
  receiver_name: string | null;
  receiver_code: string | null;
  last_gate_direction: 'IN' | 'OUT' | null;
  last_gate_event_at: string | null;
  last_gate_source: string | null;
  expected_by: string | null;
  open_alerts: number;
  zone: string;
}

export interface HandoverLive {
  id: string;
  handover_no: number;
  handover_type: HandoverType;
  mode: 'ONE_TO_ONE' | 'ONE_TO_MANY';
  status: HandoverStatus;
  handing_employee_id: string;
  handing_code: string;
  handing_name: string;
  is_demo: boolean;
  received_by_employee_id: string | null;
  receiver_code: string | null;
  receiver_name: string | null;
  source_area_name: string | null;
  source_label: string | null;
  destination_area_id: string | null;
  destination_area_name: string | null;
  route_ref: string | null;
  pickup_destination: string | null;
  pending_since: string;
  due_at: string | null;
  started_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  verification_required: boolean;
  awaiting_verification: boolean;
  pending_reason: string | null;
  discrepancy_remarks: string | null;
  remarks: string | null;
  supervisor_name: string | null;
  is_overdue: boolean;
  age_seconds: number;
  items_total: number;
  items_accepted: number;
  items_disputed: number;
  is_pickup_return: boolean;
}

export interface HandoverItem {
  id: string;
  handover_id: string;
  item_type: string;
  reference: string;
  quantity: number;
  status: 'PENDING' | 'ACCEPTED' | 'DISPUTED';
  received_by_employee_id: string | null;
  received_at: string | null;
  remarks: string | null;
}

export interface Area {
  id: string;
  code: string;
  name: string;
  kind: AreaKind;
  capacity: number | null;
  receives_handover: boolean;
  sort_order: number;
  is_active: boolean;
}

export interface Shift {
  id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  crosses_midnight: boolean;
  is_active: boolean;
}

export interface Alert {
  id: string;
  alert_type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  employee_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  message: string | null;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  first_detected_at: string;
  last_detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  auto_resolved: boolean;
}

export interface Device {
  id: string;
  device_code: string;
  name: string;
  adapter: string;
  direction_mode: string;
  location_label: string | null;
  is_active: boolean;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  last_sync_at: string | null;
  pending_events_reported: number | null;
  firmware: string | null;
  has_kiosk_link?: boolean | number;
}

export interface GateLogRow {
  id: string;
  event_time: string;
  received_at: string;
  direction: 'IN' | 'OUT';
  source: string;
  purpose: ExitPurpose | null;
  processing_status: string;
  processing_note: string | null;
  match_confidence: number | null;
  person_ref: string | null;
  reason: string | null;
  employee_id: string | null;
  employee_code: string | null;
  full_name: string | null;
  device_code: string | null;
  device_name: string | null;
  is_demo: boolean | null;
  snapshot?: string | null;
}

export type Kpis = Record<
  | 'total_on_shift' | 'inside' | 'outside' | 'on_pickup' | 'on_break' | 'primary' | 'secondary' | 'staging'
  | 'dock' | 'other_blocks' | 'handover_pending' | 'handover_overdue' | 'unassigned' | 'exceptions' | 'not_checked_in',
  number> & { computed_at: string };

export interface RpcResult {
  ok: boolean;
  code?: string;
  message?: string;
  [k: string]: unknown;
}
