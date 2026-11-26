"""Business rules: the single place where MP state changes.

Every public action runs inside db.write() (one serialised SQLite transaction),
so a failure anywhere rolls back everything. Rules:
  * exactly one current status per MP (mp_current_state + CHECK constraints)
  * a gate IN never completes a handover
  * history tables are append-only; corrections are new events
  * UI actions carry the version they rendered -> stale screens get CONFLICT
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .db import dumps, iso, new_id, now_iso, one, parse_ts, rows, utcnow


# ---------------------------------------------------------------- errors
class AppError(Exception):
    status = 400
    code = "BAD_INPUT"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class BadInput(AppError):
    status, code = 400, "BAD_INPUT"


class NotFound(AppError):
    status, code = 404, "NOT_FOUND"


class Conflict(AppError):
    status, code = 409, "CONFLICT"


class InvalidState(AppError):
    status, code = 422, "INVALID_STATE"


class Forbidden(AppError):
    status, code = 403, "FORBIDDEN"

    def __init__(self, action: str, details: dict | None = None):
        super().__init__(f"You are not authorised to perform: {action}")
        self.action = action
        self.details = details or {}


STAFF_ROLES = ("admin", "ops_manager", "supervisor", "gate_operator")
INSIDE_STATUSES = ("INSIDE_UNASSIGNED", "WORKING", "ON_BREAK", "HANDOVER_PENDING", "HANDOVER_IN_PROGRESS", "HANDOVER_DISPUTED")
OUTSIDE_STATUSES = ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL", "OUTSIDE_BREAK", "OUTSIDE_OTHER", "OUTSIDE_UNDECLARED", "SHIFT_ENDED")
HANDOVER_ACTIVE = ("PENDING", "IN_PROGRESS")


# ---------------------------------------------------------------- context
class Ctx:
    """Connection + acting user (None = device / system)."""

    def __init__(self, c: sqlite3.Connection, user: dict | None = None):
        self.c = c
        self.user = user

    @property
    def uid(self) -> str | None:
        return self.user["id"] if self.user else None

    @property
    def role(self) -> str | None:
        return self.user["role"] if self.user else None

    @property
    def my_emp(self) -> str | None:
        return self.user.get("employee_id") if self.user else None

    def has(self, *roles: str) -> bool:
        return self.role in roles

    # small query helpers
    def one(self, sql: str, p: Any = ()) -> dict | None:
        return one(self.c, sql, p)

    def rows(self, sql: str, p: Any = ()) -> list[dict]:
        return rows(self.c, sql, p)

    def ex(self, sql: str, p: Any = ()) -> sqlite3.Cursor:
        return self.c.execute(sql, p)


# ---------------------------------------------------------------- settings & time
def setting(x: Ctx, key: str, default: Any = None) -> Any:
    r = x.one("SELECT value FROM settings WHERE key=?", (key,))
    return json.loads(r["value"]) if r else default


def s_int(x: Ctx, key: str, default: int) -> int:
    try:
        return int(float(setting(x, key, default)))
    except (TypeError, ValueError):
        return default


def site_tz(x: Ctx) -> ZoneInfo:
    return ZoneInfo(setting(x, "timezone", "Asia/Kolkata"))


def _hm(s: str) -> dtime:
    h, m = s.split(":")[:2]
    return dtime(int(h), int(m))


def crosses_midnight(shift: dict) -> bool:
    return _hm(shift["end_time"]) <= _hm(shift["start_time"])


def business_date(x: Ctx, shift_id: str | None, t: datetime) -> date:
    local = t.astimezone(site_tz(x))
    if shift_id:
        s = x.one("SELECT * FROM shifts WHERE id=?", (shift_id,))
        if s and crosses_midnight(s) and local.time() < _hm(s["end_time"]):
            return local.date() - timedelta(days=1)
    return local.date()


# Shift follows the DC IN time (not a fixed shift on the employee): the window the entry falls in, site local time, [from, to).
SHIFT_ENTRY_WINDOWS = {"A1": ("06:30", "08:30"), "A2": ("08:30", "10:00"), "B1": ("10:00", "11:00"),
                       "B2": ("11:00", "13:00"), "C1": ("19:00", "21:30"), "C2": ("21:30", "23:30")}


def shift_for_entry(x: Ctx, t: datetime) -> str | None:
    """shift id for a DC IN at time t, or None when the entry is outside every window (then the employee's own default, if any, applies)."""
    lt = t.astimezone(site_tz(x)).time()
    for code, (a, b) in SHIFT_ENTRY_WINDOWS.items():
        if _hm(a) <= lt < _hm(b):
            r = x.one("SELECT id FROM shifts WHERE upper(code)=? AND is_active=1", (code,))
            if r:
                return r["id"]
    return None


def shift_end_at(x: Ctx, attendance_id: str | None) -> datetime | None:
    if not attendance_id:
        return None
    a = x.one("SELECT a.business_date, s.start_time, s.end_time FROM shift_attendance a "
              "JOIN shifts s ON s.id = a.shift_id WHERE a.id=?", (attendance_id,))
    if not a:
        return None
    d = date.fromisoformat(a["business_date"])
    if crosses_midnight(a):
        d += timedelta(days=1)
    return datetime.combine(d, _hm(a["end_time"]), tzinfo=site_tz(x)).astimezone(timezone.utc)


def mins(m: int) -> timedelta:
    return timedelta(minutes=m)


# ---------------------------------------------------------------- permissions
def can_view(x: Ctx, emp: str) -> bool:
    r = x.role
    if r is None:
        return False
    if r in ("admin", "ops_manager", "gate_operator"):
        return True
    if r == "mp":
        return emp == x.my_emp
    if setting(x, "supervisor_visibility", "all") == "all":
        return True
    if x.one("SELECT 1 FROM employees WHERE id=? AND default_supervisor_user_id=?", (emp, x.uid)):
        return True
    s = x.one("SELECT s.assignment_id, wa.supervisor_user_id, wa.area_id FROM mp_current_state s "
              "LEFT JOIN work_assignments wa ON wa.id = s.assignment_id WHERE s.employee_id=?", (emp,))
    if not s or s["assignment_id"] is None:
        return True
    if s["supervisor_user_id"] == x.uid:
        return True
    return bool(x.one("SELECT 1 FROM supervisor_areas WHERE user_id=? AND area_id=?", (x.uid, s["area_id"])))


def can_manage(x: Ctx, emp: str) -> bool:
    if x.has("admin"):                    # ops_manager is view-only
        return True
    return x.has("supervisor") and can_view(x, emp)


def require(cond: bool, x: Ctx, action: str, **details) -> None:
    if not cond:
        raise Forbidden(action, details)


def log_security_event(c: sqlite3.Connection, user: dict | None, action: str, details: dict) -> None:
    c.execute("INSERT INTO security_events(occurred_at, user_id, role, action, outcome, details) VALUES (?,?,?,?, 'DENIED', ?)",
              (now_iso(), user and user["id"], user and user["role"], action, dumps(details)))


def audit(x: Ctx, action: str, entity_type: str | None, entity_id: str | None, reason: str | None,
          before: Any = None, after: Any = None) -> None:
    x.ex("INSERT INTO audit_logs(occurred_at, actor_user_id, actor_role, action, entity_type, entity_id, reason, before_data, after_data) "
         "VALUES (?,?,?,?,?,?,?,?,?)", (now_iso(), x.uid, x.role, action, entity_type, entity_id, reason, dumps(before), dumps(after)))


# ---------------------------------------------------------------- idempotency
def idem_get(x: Ctx, req: str | None) -> dict | None:
    if not req:
        return None
    r = x.one("SELECT result FROM request_log WHERE client_request_id=?", (req,))
    if not r:
        return None
    out = json.loads(r["result"])
    out["idempotent_replay"] = True
    return out


def idem_put(x: Ctx, req: str | None, action: str, result: dict) -> dict:
    if req and result.get("ok"):
        x.ex("INSERT OR IGNORE INTO request_log(client_request_id, action, user_id, result, created_at) VALUES (?,?,?,?,?)",
             (req, action, x.uid, json.dumps(result, default=str), now_iso()))
    return result


def ok(**kw) -> dict:
    return {"ok": True, **kw}


# ---------------------------------------------------------------- alerts
def raise_alert(x: Ctx, typ: str, severity: str, emp: str | None, entity_type: str | None, entity_id: str | None,
                key: str, title: str, message: str | None, at: datetime | None = None) -> str:
    at_s = iso(at or utcnow())
    cur = x.one("SELECT id, severity FROM alerts WHERE dedupe_key=? AND status <> 'RESOLVED'", (key,))
    if cur:
        sev = max([cur["severity"], severity], key=["INFO", "WARNING", "CRITICAL"].index)
        x.ex("UPDATE alerts SET last_detected_at=max(last_detected_at, ?), message=?, severity=? WHERE id=?",
             (at_s, message, sev, cur["id"]))
        return cur["id"]
    aid = new_id()
    x.ex("INSERT INTO alerts(id, alert_type, severity, employee_id, entity_type, entity_id, dedupe_key, title, message, "
         "first_detected_at, last_detected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
         (aid, typ, severity, emp, entity_type, entity_id, key, title, message, at_s, at_s))
    return aid


def auto_resolve(x: Ctx, key: str, note: str = "Condition cleared") -> None:
    x.ex("UPDATE alerts SET status='RESOLVED', resolved_at=?, auto_resolved=1, resolution_note=? "
         "WHERE dedupe_key=? AND status <> 'RESOLVED'", (now_iso(), note, key))


# ---------------------------------------------------------------- state primitives
def ensure_state_row(x: Ctx, emp: str) -> None:
    t = now_iso()
    x.ex("INSERT OR IGNORE INTO mp_current_state(employee_id, status, presence, status_since, updated_at) "
         "VALUES (?, 'NOT_CHECKED_IN', 'UNKNOWN', ?, ?)", (emp, t, t))


def lock_state(x: Ctx, emp: str | None) -> dict:
    """The write transaction is already serialised; this validates and loads the row."""
    if not emp or not x.one("SELECT 1 FROM employees WHERE id=? AND is_active=1", (emp,)):
        raise NotFound("Employee not found or inactive")
    ensure_state_row(x, emp)
    return x.one("SELECT * FROM mp_current_state WHERE employee_id=?", (emp,))  # type: ignore[return-value]


def check_version(s: dict, expected: Any) -> None:
    if expected is not None and int(s["version"]) != int(expected):
        raise Conflict(f"MP state changed (version {s['version']} vs expected {expected}). Refresh and retry.")


_KEEP = object()


def transition(x: Ctx, emp: str, status: str, presence: str, t: datetime, *, assignment: str | None = None,
               pickup: str | None = None, brk: str | None = None, handover: str | None = None,
               expected_by: datetime | None = None, attendance: Any = _KEEP, gate: str | None = None,
               gate_dir: str | None = None, event: str = "STATE_CHANGE", reason: str | None = None,
               device: str | None = None) -> dict:
    old = x.one("SELECT * FROM mp_current_state WHERE employee_id=?", (emp,))
    att = old["attendance_id"] if attendance is _KEEP else attendance
    ts = iso(t)
    x.ex("""UPDATE mp_current_state SET status=?, presence=?, status_since=?, assignment_id=?, pickup_id=?, break_id=?,
            handover_id=?, expected_by=?, attendance_id=?, last_gate_event_id=coalesce(?, last_gate_event_id),
            last_gate_direction=coalesce(?, last_gate_direction), last_gate_event_at=coalesce(?, last_gate_event_at),
            version=version+1, updated_at=?, updated_by=? WHERE employee_id=?""",
         (status, presence, ts, assignment, pickup, brk, handover, iso(expected_by), att, gate, gate_dir,
          ts if gate else None, now_iso(), x.uid, emp))
    area = x.one("SELECT area_id FROM work_assignments WHERE id=?", (assignment,)) if assignment else None
    x.ex("""INSERT INTO movement_events(employee_id, event_type, from_status, to_status, presence, area_id, started_at,
            attendance_id, assignment_id, pickup_id, break_id, handover_id, gate_event_id, device_id, actor_user_id, reason, recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
         (emp, event, old["status"], status, presence, area and area["area_id"], ts, att, assignment, pickup, brk, handover,
          gate, device, x.uid, reason, now_iso()))
    return x.one("SELECT * FROM mp_current_state WHERE employee_id=?", (emp,))  # type: ignore[return-value]


def open_assignment(x: Ctx, emp: str, area: str, task: str | None, process: str | None, supervisor: str | None,
                    attendance: str | None, transfer_from: str | None, at: datetime) -> str:
    if not x.one("SELECT 1 FROM areas WHERE id=? AND is_active=1", (area,)):
        raise NotFound("Work area not found or disabled")
    if not supervisor:
        r = x.one("SELECT default_supervisor_user_id FROM employees WHERE id=?", (emp,))
        supervisor = r and r["default_supervisor_user_id"]
    aid = new_id()
    x.ex("INSERT INTO work_assignments(id, employee_id, area_id, task, process, supervisor_user_id, attendance_id, "
         "transfer_from_assignment_id, started_at, assigned_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
         (aid, emp, area, task, process, supervisor, attendance, transfer_from, iso(at), x.uid))
    return aid


def close_assignment(x: Ctx, aid: str | None, at: datetime, reason: str) -> dict | None:
    if not aid:
        return None
    wa = x.one("SELECT * FROM work_assignments WHERE id=? AND ended_at IS NULL", (aid,))
    if not wa:
        return None
    end = max(iso(at), wa["started_at"])
    x.ex("UPDATE work_assignments SET ended_at=?, end_reason=?, ended_by=? WHERE id=?", (end, reason, x.uid, aid))
    wa.update(ended_at=end, end_reason=reason)
    return wa


def end_break_record(x: Ctx, bid: str | None, at: datetime, gate: str | None = None) -> dict | None:
    if not bid:
        return None
    b = x.one("SELECT * FROM break_records WHERE id=? AND ended_at IS NULL", (bid,))
    if not b:
        return None
    end = max(iso(at), b["started_at"])
    x.ex("UPDATE break_records SET ended_at=?, ended_by=?, end_gate_event_id=? WHERE id=?", (end, x.uid, gate, bid))
    auto_resolve(x, f"BREAK_EXCEEDED:{bid}", "Break ended")
    b["ended_at"] = end
    return b


def break_allowed(x: Ctx, typ: str) -> int:
    return int((setting(x, "break_allowed_minutes", {}) or {}).get(typ, 30))


def lunch_taken(x: Ctx, emp: str, att_id: str | None, at: datetime, exclude: str | None = None) -> tuple[list[tuple[datetime, datetime]], float]:
    """Lunch breaks of this shift (attendance) -> ([(start, end)], total minutes). Lunch may be taken in parts;
    the parts together may not exceed the lunch limit (45 min)."""
    att = x.one("SELECT checked_in_at FROM shift_attendance WHERE id=?", (att_id,)) if att_id else None
    if not att:
        return [], 0.0
    out = []
    for b in x.rows("SELECT id, started_at, ended_at FROM break_records WHERE employee_id=? AND break_type='LUNCH' "
                    "AND started_at >= ? ORDER BY started_at", (emp, att["checked_in_at"])):
        if b["id"] == exclude:
            continue
        st = parse_ts(b["started_at"])
        en = parse_ts(b["ended_at"]) if b["ended_at"] else at
        out.append((st, max(st, en)))
    return out, sum((e - s).total_seconds() for s, e in out) / 60


def _break_left(x: Ctx, emp: str, s: dict, btype: str, t: datetime) -> int:
    """Minutes allowed for this break: lunch = limit minus lunch already taken this shift."""
    limit = break_allowed(x, btype)
    if btype != "LUNCH":
        return limit
    _, used = lunch_taken(x, emp, s.get("attendance_id"), t)
    return max(1, int(round(limit - used)))


def create_handover_record(x: Ctx, emp: str, typ: str, source_area: str | None, source_label: str | None,
                           dest_area: str | None, pickup: str | None, at: datetime, items: list | None,
                           remarks: str | None) -> str:
    mode = (setting(x, "handover_mode_by_type", {}) or {}).get(typ, "ONE_TO_ONE")
    verify = 1 if typ in (setting(x, "handover_verification_types", []) or []) else 0
    hid = new_id()
    no = (x.one("SELECT coalesce(max(handover_no), 0) + 1 AS n FROM handover_records") or {"n": 1})["n"]
    try:
        x.ex("""INSERT INTO handover_records(id, handover_no, handing_employee_id, handover_type, mode, source_area_id, source_label,
                destination_area_id, pickup_assignment_id, status, pending_since, due_at, verification_required, remarks, created_by, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?,?,?,?,?,?)""",
             (hid, no, emp, typ, mode, source_area, source_label, dest_area, pickup, iso(at),
              iso(at + mins(s_int(x, "handover_overdue_minutes", 15))), verify, remarks, x.uid, now_iso()))
    except sqlite3.IntegrityError as e:
        raise Conflict("MP already has an active handover") from e
    add_items(x, hid, items or [])
    handover_event(x, hid, "CREATED", None, "PENDING", None, {"pickup_id": pickup, "items": len(items or [])})
    return hid


def add_items(x: Ctx, hid: str, items: list) -> int:
    n = 0
    seen = set()
    for it in items:
        ref = str(it.get("reference") or "").strip()
        if not ref:
            raise BadInput("Every item needs a reference")
        typ = str(it.get("item_type") or "OTHER").upper()
        if typ not in ("SHIPMENT", "BAG", "MANIFEST", "EQUIPMENT", "DOCUMENT", "TASK", "OTHER"):
            raise BadInput(f"Unknown item type {typ}")
        try:
            qty = int(it.get("quantity") or 1)
        except (TypeError, ValueError) as e:
            raise BadInput("Quantity must be a whole number") from e
        if (typ, ref) in seen:
            continue
        seen.add((typ, ref))
        cur = x.ex("INSERT OR IGNORE INTO handover_items(id, handover_id, item_type, reference, quantity, remarks, created_at) "
                   "VALUES (?,?,?,?,?,?,?)", (new_id(), hid, typ, ref, qty, it.get("remarks"), now_iso()))
        n += cur.rowcount
    return n


def handover_event(x: Ctx, hid: str, typ: str, frm: str | None, to: str | None, receiver: str | None, details: Any) -> None:
    x.ex("INSERT INTO handover_events(handover_id, event_type, from_status, to_status, actor_user_id, actor_employee_id, details, created_at) "
         "VALUES (?,?,?,?,?,?,?,?)", (hid, typ, frm, to, x.uid, receiver or x.my_emp, dumps(details), now_iso()))


# ---------------------------------------------------------------- gate engine
def reopenable_attendance(x: Ctx, emp: str, t: datetime) -> str | None:
    """Id of this MP's last attendance when he comes back after completing the minimum shift hours (9 h counted from the FIRST IN).
    Coming back is a normal IN/OUT of the same duty (no new shift, no late IN, no approval); the attendance end time is simply the
    last transaction time."""
    r = x.one("SELECT id, checked_in_at, checked_out_at FROM shift_attendance WHERE employee_id=? AND checked_out_at IS NOT NULL "
              "AND check_out_reason='GATE_OUT' ORDER BY checked_out_at DESC LIMIT 1", (emp,))
    if not r or not r["checked_in_at"]:
        return None
    need = float(setting(x, "dc_min_shift_hours", 9)) * 60
    if (parse_ts(r["checked_out_at"]) - parse_ts(r["checked_in_at"])).total_seconds() / 60 < need:
        return None   # went home early (early leave etc.) -> a fresh IN is a new shift
    if (t - parse_ts(r["checked_out_at"])).total_seconds() > float(setting(x, "dc_reentry_hours", 12)) * 3600:
        return None
    return r["id"]


def _apply_gate_in(x: Ctx, s: dict, ge: str, t: datetime, device: str | None) -> dict:
    emp = s["employee_id"]
    g = dict(gate=ge, gate_dir="IN", device=device)
    if s["status"] in ("NOT_CHECKED_IN", "SHIFT_ENDED") or not s["attendance_id"]:
        att = x.one("SELECT id FROM shift_attendance WHERE employee_id=? AND checked_out_at IS NULL", (emp,))
        re_id = None if att else reopenable_attendance(x, emp, t)
        if att:
            att_id = att["id"]
        elif re_id:   # back after 9 h+ -> same attendance continues, its end time moves with the last OUT
            x.ex("UPDATE shift_attendance SET checked_out_at=NULL, check_out_gate_event_id=NULL, check_out_reason=NULL WHERE id=?", (re_id,))
            att_id = re_id
        else:
            shift = shift_for_entry(x, t) or (x.one("SELECT default_shift_id FROM employees WHERE id=?", (emp,)) or {}).get("default_shift_id")
            att_id = new_id()
            x.ex("INSERT INTO shift_attendance(id, employee_id, shift_id, business_date, checked_in_at, check_in_gate_event_id) "
                 "VALUES (?,?,?,?,?,?)", (att_id, emp, shift, business_date(x, shift, t).isoformat(), iso(t), ge))
        return transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", t, attendance=att_id, event="SHIFT_START", **g)

    if s["pickup_id"]:
        p = x.one("SELECT * FROM pickup_assignments WHERE id=?", (s["pickup_id"],))
        ret = max(iso(t), p["departed_at"] or iso(t))
        x.ex("UPDATE pickup_assignments SET status='RETURNED', returned_at=?, return_gate_event_id=? WHERE id=?", (ret, ge, p["id"]))
        auto_resolve(x, f"PICKUP_DELAYED:{p['id']}", "MP returned")
        if p["handover_required"]:
            h = x.one("SELECT id, due_at FROM handover_records WHERE handing_employee_id=? AND status IN ('PENDING','IN_PROGRESS')", (emp,))
            if not h:
                hid = create_handover_record(x, emp, p["handover_type"], None, p["destination"] or p["route_ref"] or "External",
                                             p["receiving_area_id"], p["id"], t, [], None)
                h = x.one("SELECT id, due_at FROM handover_records WHERE id=?", (hid,))
            return transition(x, emp, "HANDOVER_PENDING", "INSIDE", t, handover=h["id"], expected_by=parse_ts(h["due_at"]),
                              event="PICKUP_RETURN", **g)
        if p["next_area_id"]:
            a = open_assignment(x, emp, p["next_area_id"], None, None, p["supervisor_user_id"], s["attendance_id"], None, t)
            return transition(x, emp, "WORKING", "INSIDE", t, assignment=a, event="PICKUP_RETURN", **g)
        return transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", t, event="PICKUP_RETURN", **g)

    if s["status"] == "OUTSIDE_BREAK" and s["break_id"]:
        b = end_break_record(x, s["break_id"], t, ge)
        if setting(x, "break_resume_previous_assignment", True) and b and b["resume_area_id"]:
            a = open_assignment(x, emp, b["resume_area_id"], b["resume_task"], None, None, s["attendance_id"], None, t)
            return transition(x, emp, "WORKING", "INSIDE", t, assignment=a, event="BREAK_END", **g)
        return transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", t, event="BREAK_END", **g)

    auto_resolve(x, f"UNDECLARED_EXIT:{emp}", "MP re-entered")
    return transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", t, event="GATE_IN", **g)


def _apply_gate_out(x: Ctx, s: dict, ge: str, t: datetime, purpose: str | None, device: str | None) -> dict:
    emp = s["employee_id"]
    g = dict(gate=ge, gate_dir="OUT", device=device)
    p = x.one("SELECT * FROM pickup_assignments WHERE employee_id=? AND status='PLANNED'", (emp,))
    if purpose is None:
        if p:
            purpose = p["purpose"]
        elif s["status"] == "ON_BREAK":
            purpose = "BREAK"
        else:
            end = shift_end_at(x, s["attendance_id"])
            if end and t >= end - mins(s_int(x, "shift_end_window_minutes", 45)):
                purpose = "SHIFT_END"

    if s["status"] in ("HANDOVER_PENDING", "HANDOVER_IN_PROGRESS"):
        raise_alert(x, "LEFT_WITH_PENDING_HANDOVER", "CRITICAL", emp, "handover", s["handover_id"],
                    f"LEFT_WITH_HANDOVER:{s['handover_id']}", "MP left DC with handover not completed",
                    f"Gate OUT recorded while handover is {s['status']}", t)

    wa = close_assignment(x, s["assignment_id"], t, "GATE_OUT")

    if purpose in ("PICKUP", "OFFICIAL") or (purpose == "OTHER" and p):
        end_break_record(x, s["break_id"], t, ge)
        default_ret = t + mins(s_int(x, "pickup_default_expected_minutes", 120))
        if not p:
            pid = new_id()
            x.ex("INSERT INTO pickup_assignments(id, employee_id, purpose, status, planned_at, planned_by, departed_at, "
                 "departure_gate_event_id, expected_return_at, handover_required, notes) VALUES (?,?,?, 'OUT', ?,?,?,?,?,?,?)",
                 (pid, emp, purpose, iso(t), x.uid, iso(t), ge, iso(default_ret), 1 if purpose == "PICKUP" else 0,
                  "Ad-hoc: purpose declared at gate, no prior plan"))
        else:
            pid = p["id"]
            x.ex("UPDATE pickup_assignments SET status='OUT', departed_at=?, departure_gate_event_id=?, "
                 "expected_return_at=coalesce(expected_return_at, ?) WHERE id=?", (iso(t), ge, iso(default_ret), pid))
        p = x.one("SELECT * FROM pickup_assignments WHERE id=?", (pid,))
        st = {"PICKUP": "OUTSIDE_PICKUP", "OFFICIAL": "OUTSIDE_OFFICIAL"}.get(p["purpose"], "OUTSIDE_OTHER")
        return transition(x, emp, st, "OUTSIDE", t, pickup=pid, expected_by=parse_ts(p["expected_return_at"]),
                          event="PICKUP_DEPART", **g)

    if purpose in ("LUNCH", "BREAK"):
        if s["break_id"]:
            x.ex("UPDATE break_records SET location='OUTSIDE', start_gate_event_id=coalesce(start_gate_event_id, ?) WHERE id=?",
                 (ge, s["break_id"]))
            bid = s["break_id"]
        else:
            btype = "LUNCH" if purpose == "LUNCH" else "TEA"
            bid = new_id()
            x.ex("INSERT INTO break_records(id, employee_id, break_type, location, started_at, allowed_minutes, resume_area_id, "
                 "resume_task, started_by, start_gate_event_id) VALUES (?,?,?, 'OUTSIDE', ?,?,?,?,?,?)",
                 (bid, emp, btype, iso(t), _break_left(x, emp, s, btype, t), wa and wa["area_id"], wa and wa["task"], x.uid, ge))
        b = x.one("SELECT started_at, allowed_minutes FROM break_records WHERE id=?", (bid,))
        return transition(x, emp, "OUTSIDE_BREAK", "OUTSIDE", t, brk=bid,
                          expected_by=parse_ts(b["started_at"]) + mins(b["allowed_minutes"]), event="BREAK_OUTSIDE", **g)

    end_break_record(x, s["break_id"], t, ge)

    if purpose == "SHIFT_END":
        x.ex("UPDATE shift_attendance SET checked_out_at=max(?, checked_in_at), check_out_gate_event_id=?, check_out_reason='GATE_OUT' "
             "WHERE id=? AND checked_out_at IS NULL", (iso(t), ge, s["attendance_id"]))
        auto_resolve(x, f"MISSING_CHECKOUT:{s['attendance_id']}", "Checked out")
        auto_resolve(x, f"IDLE_UNASSIGNED:{emp}", "Checked out")
        return transition(x, emp, "SHIFT_ENDED", "OUTSIDE", t, attendance=None, event="SHIFT_END", **g)

    if purpose == "OTHER":
        return transition(x, emp, "OUTSIDE_OTHER", "OUTSIDE", t, event="GATE_OUT_OTHER", **g)

    raise_alert(x, "UNDECLARED_EXIT", "WARNING", emp, "employee", emp, f"UNDECLARED_EXIT:{emp}",
                "MP left DC without a declared purpose",
                "Gate OUT with no pickup plan, break or shift-end window. Supervisor to classify.", t)
    return transition(x, emp, "OUTSIDE_UNDECLARED", "OUTSIDE", t, event="GATE_OUT_UNDECLARED", **g)


def process_gate_event(x: Ctx, emp: str | None, direction: str, event_time: Any, source: str, *,
                       device_id: str | None = None, device_event_id: str | None = None,
                       client_request_id: str | None = None, purpose: str | None = None,
                       confidence: float | None = None, person_ref: str | None = None, reason: str | None = None,
                       corrects: str | None = None, force: bool = False, raw: Any = None) -> dict:
    if direction not in ("IN", "OUT"):
        raise BadInput("direction must be IN or OUT")
    if purpose is not None and purpose not in ("PICKUP", "LUNCH", "BREAK", "OFFICIAL", "SHIFT_END", "OTHER"):
        raise BadInput(f"Unknown purpose {purpose}")
    t = parse_ts(event_time) or utcnow()
    now = utcnow()
    if device_id:
        x.ex("UPDATE devices SET last_event_at=max(coalesce(last_event_at, ?), ?), last_sync_at=? WHERE id=?",
             (iso(min(t, now)), iso(min(t, now)), iso(now), device_id))

    def insert(status: str | None, note: str | None, e: str | None) -> str:
        gid = new_id()
        x.ex("""INSERT INTO gate_events(id, employee_id, device_id, device_event_id, client_request_id, person_ref, direction,
                event_time, received_at, source, purpose, match_confidence, processing_status, processing_note, corrects_event_id,
                actor_user_id, reason, raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
             (gid, e, device_id, device_event_id, client_request_id, person_ref, direction, iso(t), iso(now), source, purpose,
              confidence, status, note, corrects, x.uid, reason, dumps(raw)))
        return gid

    def existing() -> str | None:
        r = None
        if device_event_id and device_id:
            r = x.one("SELECT id FROM gate_events WHERE device_id=? AND device_event_id=?", (device_id, device_event_id))
        if not r and client_request_id:
            r = x.one("SELECT id FROM gate_events WHERE client_request_id=?", (client_request_id,))
        return r["id"] if r else None

    if emp is None:
        dup = existing()
        if dup:
            return ok(applied=False, gate_event_id=dup, processing_status="DUPLICATE_SUBMISSION")
        gid = insert("REJECTED", reason or "Person not matched to an active employee", None)
        return ok(applied=False, gate_event_id=gid, processing_status="REJECTED")

    s = lock_state(x, emp)
    dup = existing()
    if dup:
        return ok(applied=False, gate_event_id=dup, processing_status="DUPLICATE_SUBMISSION", status=s["status"])

    status = note = None
    last = parse_ts(s["last_gate_event_at"])
    window = s_int(x, "gate_duplicate_window_seconds", 120)
    if t > now + timedelta(seconds=s_int(x, "gate_max_clock_skew_seconds", 300)):
        status, note = "REJECTED", "Event time is in the future (device clock skew)"
    elif force:
        if (direction == "IN" and s["presence"] == "INSIDE") or (direction == "OUT" and s["presence"] != "INSIDE"):
            raise InvalidState(f"MP is already {s['presence']}; a forced {direction} makes no sense")
        floor = max([d for d in (last, None if s["status"] == "NOT_CHECKED_IN" else parse_ts(s["status_since"])) if d],
                    default=None)
        if floor and t < floor:
            raise InvalidState(f"Correction time is before the MP's last recorded event ({iso(floor)})")
    elif last and t < last:
        status, note = "OUT_OF_ORDER", f"Older than last applied gate event ({iso(last)}); held for review"
    elif (direction == "IN" and s["presence"] == "INSIDE") or (direction == "OUT" and s["presence"] != "INSIDE"):
        if s["last_gate_direction"] == direction and last and (t - last).total_seconds() <= window:
            status, note = "DUPLICATE", f"Repeat {direction} within {window}s"
        else:
            status = "SUSPICIOUS"
            note = ("OUT without a prior IN" if direction == "OUT" and s["presence"] == "UNKNOWN"
                    else f"Consecutive {direction} without opposite event")

    if status:
        gid = insert(status, note, emp)
        if status in ("SUSPICIOUS", "OUT_OF_ORDER"):
            raise_alert(x, f"GATE_{status}", "WARNING", emp, "gate_event", gid, f"GATE_{status}:{gid}",
                        f"Gate event needs review: {status}", note)
        return ok(applied=False, gate_event_id=gid, processing_status=status, note=note, status=s["status"])

    gid = insert("APPLIED", None, emp)
    if direction == "IN":
        s = _apply_gate_in(x, s, gid, t, device_id)
    else:
        s = _apply_gate_out(x, s, gid, t, purpose, device_id)
    return ok(applied=True, gate_event_id=gid, processing_status="APPLIED", status=s["status"],
              presence=s["presence"], version=s["version"])


def employee_by_scan(x: Ctx, scan: str) -> str | None:
    v = (scan or "").strip()
    r = x.one("SELECT id FROM employees WHERE is_active=1 AND (badge_code=? OR upper(employee_code)=upper(?)) "
              "ORDER BY (badge_code=?) DESC LIMIT 1", (v, v, v))
    return r["id"] if r else None


def _infer_direction(x: Ctx, device: dict, emp: str | None) -> str:
    if device["direction_mode"] == "in_only":
        return "IN"
    if device["direction_mode"] == "out_only":
        return "OUT"
    if emp:
        s = x.one("SELECT presence, last_gate_direction, last_gate_event_at FROM mp_current_state WHERE employee_id=?", (emp,))
        if not s:
            return "IN"
        # Someone lingering at the gate / scanning twice must not flip IN -> OUT.
        last = parse_ts(s["last_gate_event_at"])
        gap = s_int(x, "auto_direction_min_gap_seconds", 120)
        if last and s["last_gate_direction"] in ("IN", "OUT") and (utcnow() - last).total_seconds() < gap:
            return s["last_gate_direction"]
        return "OUT" if s["presence"] == "INSIDE" else "IN"
    return "IN"


def kiosk_gate_scan(x: Ctx, a: dict) -> dict:
    require(x.has("gate_operator", "admin", "ops_manager", "supervisor"), x, "kiosk_gate_scan", device=a.get("p_device_code"))
    d = x.one("SELECT * FROM devices WHERE device_code=? AND is_active=1", (a.get("p_device_code"),))
    if not d:
        raise NotFound(f"Device {a.get('p_device_code')} not registered or disabled")
    emp = employee_by_scan(x, a.get("p_scan_value") or "")
    direction = a.get("p_direction") or _infer_direction(x, d, emp)
    r = process_gate_event(x, emp, direction, a.get("p_captured_at"), "QR_KIOSK", device_id=d["id"],
                           device_event_id=a.get("p_client_event_id"), purpose=a.get("p_purpose") if direction == "OUT" else None,
                           person_ref=a.get("p_scan_value"), raw={"scan": a.get("p_scan_value"), "operator": x.uid})
    e = x.one("SELECT id, employee_code AS code, full_name AS name FROM employees WHERE id=?", (emp,)) if emp else None
    return {**r, "employee": e, "direction": direction}


def ingest_device_event(x: Ctx, device: dict, ev: dict) -> dict:
    """ev: NormalizedGateEvent dict (person_ref, direction, event_time, device_event_id, confidence, purpose, raw)."""
    ref = ev["person_ref"]
    r = x.one("SELECT id FROM employees WHERE is_active=1 AND (device_person_id=? OR upper(employee_code)=upper(?) OR badge_code=?) LIMIT 1",
              (ref, ref, ref))
    emp = r["id"] if r else None
    min_conf = float(setting(x, "face_min_confidence", 0.8))
    conf = ev.get("confidence")
    if emp and conf is not None and conf < min_conf:
        return process_gate_event(x, None, ev.get("direction") or "IN", ev["event_time"], "FACE_DEVICE", device_id=device["id"],
                                  device_event_id=ev["device_event_id"], confidence=conf, person_ref=ref,
                                  reason=f"Match confidence {conf} below minimum {min_conf}", raw=ev.get("raw"))
    direction = ev.get("direction") or _infer_direction(x, device, emp)
    return process_gate_event(x, emp, direction, ev["event_time"], "FACE_DEVICE", device_id=device["id"],
                              device_event_id=ev["device_event_id"], purpose=ev.get("purpose"), confidence=conf,
                              person_ref=ref, raw=ev.get("raw"))


def device_heartbeat(x: Ctx, device_code: str, firmware: str | None, pending: int | None) -> dict:
    if x.user is not None:
        require(x.has("gate_operator", "admin", "ops_manager"), x, "device_heartbeat", device=device_code)
    d = x.one("SELECT id FROM devices WHERE device_code=? AND is_active=1", (device_code,))
    if not d:
        raise NotFound(f"Device {device_code} not registered or disabled")
    x.ex("UPDATE devices SET last_heartbeat_at=?, firmware=coalesce(?, firmware), pending_events_reported=? WHERE id=?",
         (now_iso(), firmware, pending, d["id"]))
    auto_resolve(x, f"DEVICE_OFFLINE:{d['id']}", "Heartbeat received")
    return ok(device_id=d["id"], server_time=now_iso())


def log_device_sync(x: Ctx, device_code: str, results: list[dict]) -> dict:
    d = x.one("SELECT id FROM devices WHERE device_code=?", (device_code,))
    st = [r.get("processing_status") for r in results]
    cur = x.ex("INSERT INTO device_sync_logs(device_id, received_at, batch_size, applied, duplicates, rejected, out_of_order, suspicious, details) "
               "VALUES (?,?,?,?,?,?,?,?,?)",
               (d and d["id"], now_iso(), len(results), st.count("APPLIED"),
                sum(1 for s in st if s in ("DUPLICATE", "DUPLICATE_SUBMISSION")),
                sum(1 for r in results if r.get("processing_status") in ("REJECTED", "ERROR") or r.get("ok") is False),
                st.count("OUT_OF_ORDER"), st.count("SUSPICIOUS"), dumps(results)))
    if d:
        x.ex("UPDATE devices SET last_sync_at=? WHERE id=?", (now_iso(), d["id"]))
    return ok(sync_log_id=cur.lastrowid)


# ---------------------------------------------------------------- workflow actions
def _pre(x: Ctx, a: dict, action: str, emp: str) -> tuple[dict | None, dict | None]:
    r = idem_get(x, a.get("p_client_request_id"))
    if r:
        return r, None
    s = lock_state(x, emp)
    check_version(s, a.get("p_expected_version"))
    return None, s


def assign_work(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(can_manage(x, emp), x, "assign_work", employee_id=emp, area_id=a.get("p_area_id"))
    replay, s = _pre(x, a, "assign_work", emp)
    if replay:
        return replay
    if s["status"] not in ("INSIDE_UNASSIGNED", "WORKING", "HANDOVER_DISPUTED"):
        raise InvalidState(f"cannot assign work while MP is {s['status']}")
    now = utcnow()
    old = None
    event = "ASSIGN"
    if s["status"] == "WORKING":
        cur = x.one("SELECT * FROM work_assignments WHERE id=?", (s["assignment_id"],))
        if cur["area_id"] == a.get("p_area_id") and cur["task"] == (a.get("p_task") or None):
            raise InvalidState("MP is already working in this area")
        old = close_assignment(x, s["assignment_id"], now, "TRANSFER")
        event = "TRANSFER"
    new = open_assignment(x, emp, a.get("p_area_id"), a.get("p_task") or None, a.get("p_process") or None,
                          a.get("p_supervisor_user_id") or None, s["attendance_id"], old and old["id"], now)
    s = transition(x, emp, "WORKING", "INSIDE", now, assignment=new, event=event, reason=a.get("p_reason"))
    auto_resolve(x, f"IDLE_UNASSIGNED:{emp}", "Assigned to work")
    auto_resolve(x, f"RETURNED_NOT_ASSIGNED:{emp}", "Assigned to work")
    return idem_put(x, a.get("p_client_request_id"), "assign_work",
                    ok(assignment_id=new, transferred_from=old and old["id"], event=event, version=s["version"], status=s["status"]))


def unassign_work(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(can_manage(x, emp), x, "unassign_work", employee_id=emp)
    replay, s = _pre(x, a, "unassign_work", emp)
    if replay:
        return replay
    if s["status"] != "WORKING":
        raise InvalidState(f"MP is not working (status {s['status']})")
    now = utcnow()
    close_assignment(x, s["assignment_id"], now, a.get("p_reason") or "UNASSIGNED")
    s = transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", now, event="UNASSIGN", reason=a.get("p_reason"))
    return idem_put(x, a.get("p_client_request_id"), "unassign_work", ok(version=s["version"], status=s["status"]))


def start_break(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(can_manage(x, emp) or emp == x.my_emp, x, "start_break", employee_id=emp)
    typ = str(a.get("p_break_type") or "LUNCH").upper()
    if typ not in ("LUNCH", "TEA", "OTHER"):
        raise BadInput(f"Invalid break type {typ}")
    replay, s = _pre(x, a, "start_break", emp)
    if replay:
        return replay
    if s["status"] not in ("INSIDE_UNASSIGNED", "WORKING"):
        raise InvalidState(f"cannot start a break while MP is {s['status']}")
    now = utcnow()
    wa = close_assignment(x, s["assignment_id"], now, "BREAK")   # no overlapping break + work
    allowed = break_allowed(x, typ)
    bid = new_id()
    x.ex("INSERT INTO break_records(id, employee_id, break_type, location, started_at, allowed_minutes, resume_area_id, resume_task, started_by) "
         "VALUES (?,?,?, 'INSIDE', ?,?,?,?,?)", (bid, emp, typ, iso(now), allowed, wa and wa["area_id"], wa and wa["task"], x.uid))
    s = transition(x, emp, "ON_BREAK", "INSIDE", now, brk=bid, expected_by=now + mins(allowed), event="BREAK_START")
    auto_resolve(x, f"IDLE_UNASSIGNED:{emp}", "On break")
    return idem_put(x, a.get("p_client_request_id"), "start_break", ok(break_id=bid, version=s["version"], status=s["status"]))


def end_break(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(can_manage(x, emp) or emp == x.my_emp, x, "end_break", employee_id=emp)
    replay, s = _pre(x, a, "end_break", emp)
    if replay:
        return replay
    if s["status"] == "OUTSIDE_BREAK":
        raise InvalidState("MP is outside; the break ends when the gate records IN")
    if s["status"] != "ON_BREAK":
        raise InvalidState(f"MP is not on break (status {s['status']})")
    now = utcnow()
    b = end_break_record(x, s["break_id"], now)
    if setting(x, "break_resume_previous_assignment", True) and b["resume_area_id"]:
        aid = open_assignment(x, emp, b["resume_area_id"], b["resume_task"], None, None, s["attendance_id"], None, now)
        s = transition(x, emp, "WORKING", "INSIDE", now, assignment=aid, event="BREAK_END")
    else:
        s = transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", now, event="BREAK_END")
    dur = (parse_ts(b["ended_at"]) - parse_ts(b["started_at"])).total_seconds() / 60
    return idem_put(x, a.get("p_client_request_id"), "end_break",
                    ok(break_id=b["id"], duration_minutes=round(dur, 1), version=s["version"], status=s["status"]))


def plan_pickup(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(can_manage(x, emp), x, "plan_pickup", employee_id=emp)
    purpose = a.get("p_purpose") or "PICKUP"
    if purpose not in ("PICKUP", "OFFICIAL", "OTHER"):
        raise BadInput("Purpose must be PICKUP, OFFICIAL or OTHER (use breaks for lunch)")
    if purpose == "PICKUP" and not ((a.get("p_destination") or "").strip() or (a.get("p_route_ref") or "").strip()):
        raise BadInput("Pickup needs a destination or route/reference number")
    replay, s = _pre(x, a, "plan_pickup", emp)
    if replay:
        return replay
    if s["presence"] != "INSIDE" or s["status"] in ("HANDOVER_PENDING", "HANDOVER_IN_PROGRESS"):
        raise InvalidState(f"MP must be inside and free of pending handover to plan external duty (status {s['status']})")
    if x.one("SELECT 1 FROM pickup_assignments WHERE employee_id=? AND status IN ('PLANNED','OUT')", (emp,)):
        raise Conflict("MP already has an active pickup / external duty")
    sup = (x.one("SELECT default_supervisor_user_id FROM employees WHERE id=?", (emp,)) or {}).get("default_supervisor_user_id") or x.uid
    pid = new_id()
    hreq = a.get("p_handover_required")
    x.ex("""INSERT INTO pickup_assignments(id, employee_id, purpose, destination, route_ref, client_name, supervisor_user_id,
            expected_return_at, handover_required, receiving_area_id, next_area_id, status, planned_at, planned_by, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?, 'PLANNED', ?,?,?)""",
         (pid, emp, purpose, a.get("p_destination") or None, a.get("p_route_ref") or None, a.get("p_client_name") or None, sup,
          iso(parse_ts(a.get("p_expected_return_at"))), 1 if (hreq is None or hreq) and purpose == "PICKUP" else 0,
          a.get("p_receiving_area_id") or None, a.get("p_next_area_id") or None, now_iso(), x.uid, a.get("p_notes") or None))
    g = None
    if a.get("p_depart_now"):
        g = process_gate_event(x, emp, "OUT", utcnow(), "MANUAL_ENTRY", purpose=purpose, reason="Departure recorded by supervisor")
    return idem_put(x, a.get("p_client_request_id"), "plan_pickup", ok(pickup_id=pid, gate=g))


def cancel_pickup(x: Ctx, a: dict) -> dict:
    p = x.one("SELECT * FROM pickup_assignments WHERE id=?", (a.get("p_pickup_id"),))
    if not p:
        raise NotFound("Pickup not found")
    require(can_manage(x, p["employee_id"]), x, "cancel_pickup", pickup_id=p["id"])
    if p["status"] != "PLANNED":
        raise InvalidState("only PLANNED pickups can be cancelled (MP may already be out)")
    x.ex("UPDATE pickup_assignments SET status='CANCELLED', cancelled_reason=? WHERE id=?", (a.get("p_reason"), p["id"]))
    audit(x, "PICKUP_CANCELLED", "pickup_assignments", p["id"], a.get("p_reason"), p, None)
    return ok(pickup_id=p["id"])


def _state_json(x: Ctx, emp: str) -> dict | None:
    return x.one("SELECT * FROM mp_current_state WHERE employee_id=?", (emp,))


def _apply_gate_correction(x: Ctx, emp: str, direction: str, t: Any, purpose: str | None, reason: str,
                           corrects: str | None, req: str | None) -> dict:
    before = _state_json(x, emp)
    r = process_gate_event(x, emp, direction, t or utcnow(), "CORRECTION", client_request_id=req, purpose=purpose,
                           reason=reason, corrects=corrects, force=True, raw={"corrected_by": x.uid})
    audit(x, "GATE_CORRECTION", "mp_current_state", emp, reason, before, {**(_state_json(x, emp) or {}), "gate_result": r})
    return r


def manual_gate_correction(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(x.has("admin", "ops_manager", "gate_operator") or (x.has("supervisor") and can_manage(x, emp)), x,
            "manual_gate_correction", employee_id=emp, direction=a.get("p_direction"), reason=a.get("p_reason"))
    reason = (a.get("p_reason") or "").strip()
    if len(reason) < 5:
        raise BadInput("A reason (min 5 characters) is mandatory for corrections")
    t = parse_ts(a.get("p_event_time"))
    if t and t > utcnow() + timedelta(minutes=1):
        raise BadInput("Correction time cannot be in the future")
    r = idem_get(x, a.get("p_client_request_id"))
    if r:
        return r
    if setting(x, "corrections_require_approval", False) and x.has("gate_operator", "supervisor"):
        cid = new_id()
        x.ex("INSERT INTO correction_requests(id, employee_id, correction_type, payload, reason, requested_by, requested_at) "
             "VALUES (?,?, 'GATE_EVENT', ?,?,?,?)",
             (cid, emp, dumps({"direction": a.get("p_direction"), "event_time": iso(t or utcnow()),
                               "purpose": a.get("p_purpose"), "corrects_event_id": a.get("p_corrects_event_id")}),
              reason, x.uid, now_iso()))
        audit(x, "CORRECTION_REQUESTED", "correction_requests", cid, reason)
        return idem_put(x, a.get("p_client_request_id"), "manual_gate_correction", ok(pending_approval=True, correction_request_id=cid))
    lock_state(x, emp)
    return idem_put(x, a.get("p_client_request_id"), "manual_gate_correction",
                    _apply_gate_correction(x, emp, a.get("p_direction"), t, a.get("p_purpose"), reason,
                                           a.get("p_corrects_event_id"), a.get("p_client_request_id")))


def _apply_state_override(x: Ctx, emp: str, target: str, reason: str) -> dict:
    s = lock_state(x, emp)
    before = dict(s)
    now = utcnow()
    close_assignment(x, s["assignment_id"], now, "OVERRIDE")
    end_break_record(x, s["break_id"], now)
    if s["pickup_id"]:
        x.ex("UPDATE pickup_assignments SET status='RETURNED', returned_at=?, notes=coalesce(notes || ' | ', '') || ? "
             "WHERE id=? AND status='OUT'", (iso(now), f"Closed by override: {reason}", s["pickup_id"]))
    # Active handovers are NOT completed by an override.
    if target == "INSIDE_UNASSIGNED":
        att = x.one("SELECT id FROM shift_attendance WHERE employee_id=? AND checked_out_at IS NULL", (emp,))
        if att:
            att_id = att["id"]
        else:
            shift = shift_for_entry(x, now) or (x.one("SELECT default_shift_id FROM employees WHERE id=?", (emp,)) or {}).get("default_shift_id")
            att_id = new_id()
            x.ex("INSERT INTO shift_attendance(id, employee_id, shift_id, business_date, checked_in_at) VALUES (?,?,?,?,?)",
                 (att_id, emp, shift, business_date(x, shift, now).isoformat(), iso(now)))
        s = transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", now, attendance=att_id, event="STATE_OVERRIDE", reason=reason)
    elif target == "SHIFT_ENDED":
        x.ex("UPDATE shift_attendance SET checked_out_at=?, check_out_reason=? WHERE employee_id=? AND checked_out_at IS NULL",
             (iso(now), f"OVERRIDE: {reason}", emp))
        s = transition(x, emp, "SHIFT_ENDED", "OUTSIDE", now, attendance=None, event="STATE_OVERRIDE", reason=reason)
    else:
        raise BadInput("Override target must be INSIDE_UNASSIGNED or SHIFT_ENDED")
    auto_resolve(x, f"UNDECLARED_EXIT:{emp}", "State overridden")
    audit(x, "STATE_OVERRIDE", "mp_current_state", emp, reason, before, s)
    return ok(status=s["status"], version=s["version"])


def override_mp_state(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(x.has("admin", "ops_manager") or (x.has("supervisor") and can_manage(x, emp)), x, "override_mp_state",
            employee_id=emp, target=a.get("p_target"))
    reason = (a.get("p_reason") or "").strip()
    if len(reason) < 5:
        raise BadInput("A reason (min 5 characters) is mandatory for overrides")
    s = lock_state(x, emp)
    check_version(s, a.get("p_expected_version"))
    if setting(x, "corrections_require_approval", False) and x.has("supervisor"):
        cid = new_id()
        x.ex("INSERT INTO correction_requests(id, employee_id, correction_type, payload, reason, requested_by, requested_at) "
             "VALUES (?,?, 'STATE_OVERRIDE', ?,?,?,?)", (cid, emp, dumps({"target": a.get("p_target")}), reason, x.uid, now_iso()))
        audit(x, "CORRECTION_REQUESTED", "correction_requests", cid, reason)
        return ok(pending_approval=True, correction_request_id=cid)
    return _apply_state_override(x, emp, a.get("p_target"), reason)


def decide_correction(x: Ctx, a: dict) -> dict:
    require(x.has("admin", "ops_manager"), x, "decide_correction", request_id=a.get("p_request_id"))
    c = x.one("SELECT * FROM correction_requests WHERE id=?", (a.get("p_request_id"),))
    if not c:
        raise NotFound("Correction request not found")
    if c["status"] != "PENDING":
        raise InvalidState(f"request already {c['status']}")
    r = None
    note = a.get("p_note") or ""
    if a.get("p_approve"):
        p = json.loads(c["payload"])
        reason = f"{c['reason']} [approved: {note}]"
        if c["correction_type"] == "GATE_EVENT":
            lock_state(x, c["employee_id"])
            r = _apply_gate_correction(x, c["employee_id"], p["direction"], p.get("event_time"), p.get("purpose"), reason,
                                       p.get("corrects_event_id"), None)
        else:
            r = _apply_state_override(x, c["employee_id"], p["target"], reason)
    x.ex("UPDATE correction_requests SET status=?, decided_by=?, decided_at=?, decision_note=?, result=? WHERE id=?",
         ("APPLIED" if a.get("p_approve") else "REJECTED", x.uid, now_iso(), note, dumps(r), c["id"]))
    audit(x, "CORRECTION_APPROVED" if a.get("p_approve") else "CORRECTION_REJECTED", "correction_requests", c["id"], note, c, r)
    return ok(result=r)


# ---------------------------------------------------------------- alert workflow
def _can_handle_alert(x: Ctx, al: dict) -> bool:
    if x.has("admin", "ops_manager"):
        return True
    if x.has("supervisor"):
        return al["employee_id"] is None or can_view(x, al["employee_id"])
    if x.has("gate_operator"):
        return al["alert_type"].startswith(("GATE_", "DEVICE_")) or al["alert_type"] == "UNDECLARED_EXIT"
    return False


def acknowledge_alert(x: Ctx, a: dict) -> dict:
    al = x.one("SELECT * FROM alerts WHERE id=?", (a.get("p_alert_id"),))
    if not al:
        raise NotFound("Alert not found")
    require(_can_handle_alert(x, al), x, "acknowledge_alert", alert_id=al["id"])
    if al["status"] != "OPEN":
        return ok(status=al["status"], unchanged=True)
    x.ex("UPDATE alerts SET status='ACKNOWLEDGED', acknowledged_by=?, acknowledged_at=?, resolution_note=coalesce(?, resolution_note) WHERE id=?",
         (x.uid, now_iso(), a.get("p_note"), al["id"]))
    return ok(status="ACKNOWLEDGED")


def resolve_alert(x: Ctx, a: dict) -> dict:
    al = x.one("SELECT * FROM alerts WHERE id=?", (a.get("p_alert_id"),))
    if not al:
        raise NotFound("Alert not found")
    require(_can_handle_alert(x, al), x, "resolve_alert", alert_id=al["id"])
    if len((a.get("p_note") or "").strip()) < 3:
        raise BadInput("Resolution note is required")
    if al["status"] == "RESOLVED":
        return ok(status="RESOLVED", unchanged=True)
    t = now_iso()
    x.ex("UPDATE alerts SET status='RESOLVED', resolved_by=?, resolved_at=?, resolution_note=?, "
         "acknowledged_by=coalesce(acknowledged_by, ?), acknowledged_at=coalesce(acknowledged_at, ?) WHERE id=?",
         (x.uid, t, a.get("p_note"), x.uid, t, al["id"]))
    return ok(status="RESOLVED")


# ---------------------------------------------------------------- handovers
def _lock_handover(x: Ctx, hid: str | None) -> dict:
    h = x.one("SELECT * FROM handover_records WHERE id=?", (hid,))
    if not h:
        raise NotFound("Handover not found")
    lock_state(x, h["handing_employee_id"])
    return h


def _validate_receiver(x: Ctx, h: dict, receiver: str | None) -> None:
    if not receiver:
        raise BadInput("Receiver is required")
    if receiver == h["handing_employee_id"]:
        raise InvalidState("an MP cannot receive their own handover")
    if not x.one("SELECT 1 FROM employees WHERE id=? AND is_active=1", (receiver,)):
        raise NotFound("Receiver not found or inactive")
    rs = x.one("SELECT status, presence FROM mp_current_state WHERE employee_id=?", (receiver,))
    if not rs or rs["presence"] != "INSIDE" or rs["status"] not in ("WORKING", "INSIDE_UNASSIGNED"):
        raise InvalidState(f"receiver must be inside the DC and on duty (receiver status {rs and rs['status']})")


def _can_act(x: Ctx, h: dict, receiver: str | None) -> bool:
    return can_manage(x, h["handing_employee_id"]) or (receiver is not None and receiver == x.my_emp)


def _upd_handover(x: Ctx, hid: str, **f) -> dict:
    f["updated_at"] = now_iso()
    x.ex(f"UPDATE handover_records SET {', '.join(k + '=?' for k in f)} WHERE id=?", (*f.values(), hid))
    return x.one("SELECT * FROM handover_records WHERE id=?", (hid,))  # type: ignore[return-value]


def _finish_handover(x: Ctx, h: dict) -> dict:
    for k in ("HANDOVER_OVERDUE", "LEFT_WITH_HANDOVER"):
        auto_resolve(x, f"{k}:{h['id']}", f"Handover {h['status']}")
    if h["status"] != "DISPUTED":
        auto_resolve(x, f"HANDOVER_DISPUTED:{h['id']}", f"Handover {h['status']}")
    s = _state_json(x, h["handing_employee_id"])
    if not s or s["handover_id"] != h["id"]:
        return s or {}
    now = utcnow()
    ev = f"HANDOVER_{h['status']}"
    emp = h["handing_employee_id"]
    if h["status"] == "DISPUTED":
        return transition(x, emp, "HANDOVER_DISPUTED", "INSIDE", now, handover=h["id"], event=ev)
    nxt = None
    if h["status"] == "COMPLETED" and h["pickup_assignment_id"]:
        nxt = (x.one("SELECT next_area_id FROM pickup_assignments WHERE id=?", (h["pickup_assignment_id"],)) or {}).get("next_area_id")
    if nxt:
        aid = open_assignment(x, emp, nxt, None, None, None, s["attendance_id"], None, now)
        return transition(x, emp, "WORKING", "INSIDE", now, assignment=aid, event=ev)
    return transition(x, emp, "INSIDE_UNASSIGNED", "INSIDE", now, event=ev)


def _mark_started(x: Ctx, h: dict, receiver: str, implicit: bool) -> dict:
    h = _upd_handover(x, h["id"], status="IN_PROGRESS", started_at=now_iso(),
                      received_by_employee_id=receiver if h["mode"] == "ONE_TO_ONE" else h["received_by_employee_id"])
    handover_event(x, h["id"], "STARTED", "PENDING", "IN_PROGRESS", receiver, {"implicit": True} if implicit else None)
    s = _state_json(x, h["handing_employee_id"])
    if s and s["handover_id"] == h["id"]:
        transition(x, h["handing_employee_id"], "HANDOVER_IN_PROGRESS", "INSIDE", utcnow(), handover=h["id"],
                   expected_by=parse_ts(h["due_at"]), event="HANDOVER_STARTED")
    return h


def create_handover(x: Ctx, a: dict) -> dict:
    emp = a.get("p_employee_id")
    require(can_manage(x, emp) or emp == x.my_emp, x, "create_handover", employee_id=emp)
    typ = a.get("p_handover_type")
    if typ not in ("DOCK", "PRIMARY", "SECONDARY", "STAGING", "OTHER", "PICKUP_RETURN"):
        raise BadInput("Invalid handover type")
    replay, s = _pre(x, a, "create_handover", emp)
    if replay:
        return replay
    if s["status"] not in ("WORKING", "INSIDE_UNASSIGNED"):
        raise InvalidState(f"handover can be raised only by an on-duty MP inside the DC (status {s['status']})")
    now = utcnow()
    wa = close_assignment(x, s["assignment_id"], now, "HANDOVER")
    items = a.get("p_items") or []
    if isinstance(items, str):
        items = json.loads(items)
    hid = create_handover_record(x, emp, typ, a.get("p_source_area_id") or (wa and wa["area_id"]), None,
                                 a.get("p_destination_area_id") or None, None, now, items, a.get("p_remarks"))
    h = x.one("SELECT due_at FROM handover_records WHERE id=?", (hid,))
    s = transition(x, emp, "HANDOVER_PENDING", "INSIDE", now, handover=hid, expected_by=parse_ts(h["due_at"]), event="HANDOVER_CREATED")
    return idem_put(x, a.get("p_client_request_id"), "create_handover", ok(handover_id=hid, version=s["version"], status=s["status"]))


def add_handover_items(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    require(can_manage(x, h["handing_employee_id"]) or h["handing_employee_id"] == x.my_emp, x, "add_handover_items", handover_id=h["id"])
    if h["status"] not in HANDOVER_ACTIVE:
        raise InvalidState("items can be added only while handover is PENDING/IN_PROGRESS")
    items = a.get("p_items") or []
    if isinstance(items, str):
        items = json.loads(items)
    n = add_items(x, h["id"], items)
    handover_event(x, h["id"], "ITEMS_ADDED", h["status"], h["status"], None, {"added": n})
    return ok(added=n)


def start_handover(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    rcv = a.get("p_receiver_employee_id")
    require(_can_act(x, h, rcv), x, "start_handover", handover_id=h["id"], receiver=rcv)
    r = idem_get(x, a.get("p_client_request_id"))
    if r:
        return r
    if h["status"] == "IN_PROGRESS":
        if h["mode"] == "ONE_TO_ONE" and h["received_by_employee_id"] != rcv:
            raise Conflict("handover already being received by another MP")
        return ok(handover_id=h["id"], status=h["status"], unchanged=True)
    if h["status"] != "PENDING":
        raise InvalidState(f"handover is {h['status']}")
    _validate_receiver(x, h, rcv)
    if (_state_json(x, h["handing_employee_id"]) or {}).get("presence") != "INSIDE":
        raise InvalidState("handing MP is not inside the DC")
    h = _mark_started(x, h, rcv, False)
    return idem_put(x, a.get("p_client_request_id"), "start_handover", ok(handover_id=h["id"], status=h["status"]))


def accept_handover(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    rcv = a.get("p_receiver_employee_id")
    require(_can_act(x, h, rcv), x, "accept_handover", handover_id=h["id"], receiver=rcv)
    r = idem_get(x, a.get("p_client_request_id"))
    if r:
        return r
    if h["status"] in ("COMPLETED", "REJECTED", "CANCELLED", "DISPUTED"):
        raise Conflict(f"handover already {h['status']} — duplicate or late submission ignored")
    if h["accepted_at"]:
        raise Conflict("handover already accepted and awaiting supervisor verification")
    _validate_receiver(x, h, rcv)
    if h["status"] == "PENDING":
        if (_state_json(x, h["handing_employee_id"]) or {}).get("presence") != "INSIDE":
            raise InvalidState("handing MP is not inside the DC")
        h = _mark_started(x, h, rcv, True)
    if h["mode"] == "ONE_TO_ONE" and h["received_by_employee_id"] != rcv:
        raise Conflict("one-to-one handover is assigned to a different receiver")

    accepted = 0
    total = x.one("SELECT count(*) AS n FROM handover_items WHERE handover_id=?", (h["id"],))["n"]
    if total:
        ids = a.get("p_item_ids")
        t = now_iso()
        if ids:
            q = ",".join("?" * len(ids))
            cur = x.ex(f"UPDATE handover_items SET status='ACCEPTED', accepted_quantity=quantity, received_by_employee_id=?, received_at=?, "
                       f"remarks=coalesce(?, remarks) WHERE handover_id=? AND status='PENDING' AND id IN ({q})",
                       (rcv, t, a.get("p_remarks"), h["id"], *ids))
        else:
            cur = x.ex("UPDATE handover_items SET status='ACCEPTED', accepted_quantity=quantity, received_by_employee_id=?, received_at=?, "
                       "remarks=coalesce(?, remarks) WHERE handover_id=? AND status='PENDING'", (rcv, t, a.get("p_remarks"), h["id"]))
        accepted = cur.rowcount
        if accepted == 0:
            raise InvalidState("no pending items matched for acceptance")
    pending = x.one("SELECT count(*) AS n FROM handover_items WHERE handover_id=? AND status <> 'ACCEPTED'", (h["id"],))["n"]
    handover_event(x, h["id"], "ITEMS_ACCEPTED", h["status"], h["status"], rcv,
                   {"accepted": accepted, "remaining": pending, "remarks": a.get("p_remarks")})
    req = a.get("p_client_request_id")
    if pending:
        return idem_put(x, req, "accept_handover", ok(handover_id=h["id"], status=h["status"], remaining_items=pending))
    t = now_iso()
    if h["verification_required"]:
        h = _upd_handover(x, h["id"], accepted_at=t, received_by_employee_id=h["received_by_employee_id"] or rcv,
                          received_by_user_id=x.uid, remarks=a.get("p_remarks") or h["remarks"])
        handover_event(x, h["id"], "AWAITING_VERIFICATION", "IN_PROGRESS", "IN_PROGRESS", rcv, None)
        return idem_put(x, req, "accept_handover", ok(handover_id=h["id"], status=h["status"], awaiting_verification=True))
    h = _upd_handover(x, h["id"], status="COMPLETED", accepted_at=t, completed_at=t,
                      received_by_employee_id=h["received_by_employee_id"] or rcv, received_by_user_id=x.uid,
                      remarks=a.get("p_remarks") or h["remarks"])
    handover_event(x, h["id"], "COMPLETED", "IN_PROGRESS", "COMPLETED", rcv, None)
    _finish_handover(x, h)
    return idem_put(x, req, "accept_handover", ok(handover_id=h["id"], status="COMPLETED", completed_at=t,
                                                  received_by_employee_id=h["received_by_employee_id"]))


def verify_handover(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    require(can_manage(x, h["handing_employee_id"]), x, "verify_handover", handover_id=h["id"])
    if h["status"] != "IN_PROGRESS" or not h["accepted_at"]:
        raise InvalidState("handover is not awaiting verification")
    t = now_iso()
    h = _upd_handover(x, h["id"], status="COMPLETED", completed_at=t, verified_by=x.uid, verified_at=t,
                      remarks=a.get("p_note") or h["remarks"])
    handover_event(x, h["id"], "VERIFIED", "IN_PROGRESS", "COMPLETED", None, {"note": a.get("p_note")})
    _finish_handover(x, h)
    return ok(handover_id=h["id"], status=h["status"])


def dispute_handover(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    rcv = a.get("p_receiver_employee_id")
    require(_can_act(x, h, rcv), x, "dispute_handover", handover_id=h["id"])
    remarks = (a.get("p_remarks") or "").strip()
    if len(remarks) < 3:
        raise BadInput("Discrepancy remarks are required to dispute a handover")
    if h["status"] not in HANDOVER_ACTIVE:
        raise InvalidState(f"handover is {h['status']}")
    if rcv == h["handing_employee_id"]:
        raise InvalidState("handing MP cannot dispute own handover")
    frm = h["status"]
    t = now_iso()
    ids = a.get("p_item_ids")
    if ids:
        q = ",".join("?" * len(ids))
        x.ex(f"UPDATE handover_items SET status='DISPUTED', received_by_employee_id=?, received_at=? "
             f"WHERE handover_id=? AND status='PENDING' AND id IN ({q})", (rcv, t, h["id"], *ids))
    else:
        x.ex("UPDATE handover_items SET status='DISPUTED', received_by_employee_id=?, received_at=? WHERE handover_id=? AND status='PENDING'",
             (rcv, t, h["id"]))
    h = _upd_handover(x, h["id"], status="DISPUTED", discrepancy_remarks=remarks,
                      received_by_employee_id=h["received_by_employee_id"] or rcv, started_at=h["started_at"] or t)
    handover_event(x, h["id"], "DISPUTED", frm, "DISPUTED", rcv, {"remarks": remarks, "items": ids})
    raise_alert(x, "HANDOVER_DISPUTED", "WARNING", h["handing_employee_id"], "handover", h["id"], f"HANDOVER_DISPUTED:{h['id']}",
                f"Handover #{h['handover_no']} disputed", remarks)
    _finish_handover(x, h)
    return ok(handover_id=h["id"], status=h["status"])


def resolve_handover_dispute(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    require(can_manage(x, h["handing_employee_id"]), x, "resolve_handover_dispute", handover_id=h["id"])
    note = (a.get("p_note") or "").strip()
    if len(note) < 3:
        raise BadInput("Resolution note is required")
    if h["status"] != "DISPUTED":
        raise InvalidState("handover is not disputed")
    t = now_iso()
    acc = bool(a.get("p_accept"))
    h = _upd_handover(x, h["id"], status="COMPLETED" if acc else "REJECTED", completed_at=t if acc else None,
                      verified_by=x.uid, verified_at=t, remarks=((h["remarks"] + " | ") if h["remarks"] else "") + "Resolution: " + note)
    handover_event(x, h["id"], "DISPUTE_RESOLVED", "DISPUTED", h["status"], None, {"accepted": acc, "note": note})
    audit(x, "HANDOVER_DISPUTE_RESOLVED", "handover_records", h["id"], note, None, h)
    auto_resolve(x, f"HANDOVER_DISPUTED:{h['id']}", "Dispute resolved")
    _finish_handover(x, h)
    return ok(handover_id=h["id"], status=h["status"])


def cancel_handover(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    require(can_manage(x, h["handing_employee_id"]), x, "cancel_handover", handover_id=h["id"])
    reason = (a.get("p_reason") or "").strip()
    if len(reason) < 5:
        raise BadInput("A reason (min 5 characters) is mandatory to cancel a handover")
    if h["status"] not in ("PENDING", "IN_PROGRESS", "DISPUTED"):
        raise InvalidState(f"handover is {h['status']}")
    frm = h["status"]
    h = _upd_handover(x, h["id"], status="CANCELLED", pending_reason=reason)
    handover_event(x, h["id"], "CANCELLED", frm, "CANCELLED", None, {"reason": reason})
    audit(x, "HANDOVER_CANCELLED", "handover_records", h["id"], reason, None, h)
    auto_resolve(x, f"HANDOVER_DISPUTED:{h['id']}", "Cancelled")
    _finish_handover(x, h)
    return ok(handover_id=h["id"], status=h["status"])


def set_handover_pending_reason(x: Ctx, a: dict) -> dict:
    h = _lock_handover(x, a.get("p_handover_id"))
    require(can_manage(x, h["handing_employee_id"]) or h["handing_employee_id"] == x.my_emp, x,
            "set_handover_pending_reason", handover_id=h["id"])
    if h["status"] not in HANDOVER_ACTIVE:
        raise InvalidState(f"handover is {h['status']}")
    _upd_handover(x, h["id"], pending_reason=a.get("p_reason"))
    handover_event(x, h["id"], "PENDING_REASON", h["status"], h["status"], None, {"reason": a.get("p_reason")})
    return ok()


# ---------------------------------------------------------------- sweeper
def auto_missed_punch_out(x: Ctx, now: datetime) -> int:
    """Nobody punched OUT within `auto_out_hours` (default 14) of shift start -> close the shift on its own.
    Out time = the MP's last recorded update; remarks = 'Missed Punch OUT'."""
    hours = s_int(x, "auto_out_hours", 14)
    if hours <= 0:
        return 0
    n = 0
    for a in x.rows("SELECT id, employee_id, shift_id, business_date, checked_in_at FROM shift_attendance WHERE checked_out_at IS NULL"):
        start = None
        if a["shift_id"]:
            sh = x.one("SELECT start_time FROM shifts WHERE id=?", (a["shift_id"],))
            if sh:
                start = datetime.combine(date.fromisoformat(a["business_date"]), _hm(sh["start_time"]), tzinfo=site_tz(x)).astimezone(timezone.utc)
        start = start or parse_ts(a["checked_in_at"])
        if now < start + timedelta(hours=hours):
            continue
        emp = a["employee_id"]
        s = x.one("SELECT * FROM mp_current_state WHERE employee_id=?", (emp,))
        cands = [parse_ts(a["checked_in_at"])]
        if s:
            cands += [d for d in (parse_ts(s["status_since"]), parse_ts(s["last_gate_event_at"])) if d]
        out = min(max(cands), now)
        close_assignment(x, s and s["assignment_id"], out, "AUTO_OUT")
        end_break_record(x, s and s["break_id"], out)
        x.ex("UPDATE pickup_assignments SET status='CANCELLED', cancelled_reason='Missed Punch OUT' "
             "WHERE employee_id=? AND status IN ('PLANNED','OUT')", (emp,))
        x.ex("UPDATE shift_attendance SET checked_out_at=max(?, checked_in_at), check_out_reason='Missed Punch OUT' WHERE id=?",
             (iso(out), a["id"]))
        if s:
            transition(x, emp, "SHIFT_ENDED", "OUTSIDE", out, attendance=None, event="SHIFT_END", reason="Missed Punch OUT")
        auto_resolve(x, f"MISSING_CHECKOUT:{a['id']}", "Auto OUT (Missed Punch OUT)")
        auto_resolve(x, f"IDLE_UNASSIGNED:{emp}", "Auto OUT")
        auto_resolve(x, f"UNDECLARED_EXIT:{emp}", "Auto OUT")
        e = x.one("SELECT full_name, employee_code FROM employees WHERE id=?", (emp,)) or {}
        raise_alert(x, "MISSED_PUNCH_OUT", "INFO", emp, "attendance", a["id"], f"MISSED_PUNCH_OUT:{a['id']}",
                    f"{e.get('full_name')} ({e.get('employee_code')}): Missed Punch OUT",
                    f"No OUT within {hours} h of shift start - closed automatically at {out.astimezone(site_tz(x)).strftime('%d %b %H:%M')}", now)
        n += 1
    return n


def sweep_alerts(x: Ctx, now: datetime | None = None) -> dict:
    """Run every minute by the server itself (no browser needed). Idempotent."""
    now = now or utcnow()
    n_raised = 0
    tz = site_tz(x)
    ho = s_int(x, "handover_overdue_minutes", 15)
    ret_m = s_int(x, "returned_unassigned_minutes", 10)
    idle = s_int(x, "idle_unassigned_minutes", 20)
    grace = s_int(x, "pickup_return_grace_minutes", 15)
    dev_m = s_int(x, "device_offline_minutes", 5)
    chk = s_int(x, "missing_checkout_grace_minutes", 60)

    def resolve_missing(typ: str, live_ids: set, note: str, field: str = "entity_id") -> None:
        for al in x.rows(f"SELECT id, {field} AS k FROM alerts WHERE alert_type=? AND status <> 'RESOLVED'", (typ,)):
            if al["k"] not in live_ids:
                x.ex("UPDATE alerts SET status='RESOLVED', resolved_at=?, auto_resolved=1, resolution_note=? WHERE id=?",
                     (now_iso(), note, al["id"]))

    def m_since(ts: str) -> int:
        return int((now - parse_ts(ts)).total_seconds() // 60)

    # 1. handover overdue
    act = x.rows("SELECT h.*, e.full_name, e.employee_code FROM handover_records h JOIN employees e ON e.id=h.handing_employee_id "
                 "WHERE h.status IN ('PENDING','IN_PROGRESS')")
    for h in act:
        if parse_ts(h["pending_since"]) + mins(ho) <= now:
            raise_alert(x, "HANDOVER_OVERDUE", "CRITICAL", h["handing_employee_id"], "handover", h["id"], f"HANDOVER_OVERDUE:{h['id']}",
                        f"{h['full_name']} ({h['employee_code']}): handover #{h['handover_no']} overdue",
                        f"Pending for {m_since(h['pending_since'])} min (threshold {ho})", now)
            n_raised += 1
    resolve_missing("HANDOVER_OVERDUE", {h["id"] for h in act}, "Handover no longer pending")

    # 2. pickup delayed
    outs = x.rows("SELECT p.*, e.full_name, e.employee_code FROM pickup_assignments p JOIN employees e ON e.id=p.employee_id "
                  "WHERE p.status='OUT'")
    for p in outs:
        if p["expected_return_at"] and parse_ts(p["expected_return_at"]) + mins(grace) <= now:
            exp = parse_ts(p["expected_return_at"]).astimezone(tz).strftime("%H:%M")
            raise_alert(x, "PICKUP_DELAYED", "WARNING", p["employee_id"], "pickup", p["id"], f"PICKUP_DELAYED:{p['id']}",
                        f"{p['full_name']} ({p['employee_code']}): return delayed",
                        f"Expected back {exp}" + (f" · route {p['route_ref']}" if p["route_ref"] else "")
                        + (f" · {p['destination']}" if p["destination"] else ""), now)
            n_raised += 1
    resolve_missing("PICKUP_DELAYED", {p["id"] for p in outs}, "MP returned")

    # 3. break exceeded
    brks = x.rows("SELECT b.*, e.full_name, e.employee_code FROM break_records b JOIN employees e ON e.id=b.employee_id "
                  "WHERE b.ended_at IS NULL")
    for b in brks:
        if parse_ts(b["started_at"]) + mins(b["allowed_minutes"]) <= now:
            raise_alert(x, "BREAK_EXCEEDED", "WARNING", b["employee_id"], "break", b["id"], f"BREAK_EXCEEDED:{b['id']}",
                        f"{b['full_name']} ({b['employee_code']}): {b['break_type'].lower()} break exceeded",
                        f"{m_since(b['started_at'])} min of {b['allowed_minutes']} allowed ({b['location'].lower()} DC)", now)
            n_raised += 1
    resolve_missing("BREAK_EXCEEDED", {b["id"] for b in brks}, "Break ended")

    # 4. returned-not-assigned / idle
    un = x.rows("SELECT s.*, e.full_name, e.employee_code, (SELECT m.event_type FROM movement_events m WHERE m.employee_id=s.employee_id "
                "ORDER BY m.id DESC LIMIT 1) AS last_event FROM mp_current_state s JOIN employees e ON e.id=s.employee_id "
                "WHERE s.status='INSIDE_UNASSIGNED' AND e.is_active=1 "
                # OUT already assigned (pickup / lunch / other) -> not idle
                "AND NOT EXISTS (SELECT 1 FROM pickup_assignments p WHERE p.employee_id=s.employee_id AND p.status='PLANNED') "
                "AND NOT EXISTS (SELECT 1 FROM exit_permits ep WHERE ep.employee_id=s.employee_id AND ep.status='PENDING' AND ep.valid_until >= ?)",
                (iso(now),))
    for s in un:
        since = parse_ts(s["status_since"])
        if s["last_event"] in ("PICKUP_RETURN", "HANDOVER_COMPLETED") and since + mins(ret_m) <= now:
            raise_alert(x, "RETURNED_NOT_ASSIGNED", "WARNING", s["employee_id"], "employee", s["employee_id"],
                        f"RETURNED_NOT_ASSIGNED:{s['employee_id']}",
                        f"{s['full_name']} ({s['employee_code']}): returned, not reported to next assignment",
                        f"Unassigned for {m_since(s['status_since'])} min", now)
            n_raised += 1
        elif since + mins(idle) <= now:
            raise_alert(x, "IDLE_UNASSIGNED", "INFO", s["employee_id"], "employee", s["employee_id"],
                        f"IDLE_UNASSIGNED:{s['employee_id']}", f"{s['full_name']} ({s['employee_code']}): inside but unassigned",
                        f"Unassigned for {m_since(s['status_since'])} min", now)
            n_raised += 1
    ids = {s["employee_id"] for s in un}
    resolve_missing("RETURNED_NOT_ASSIGNED", ids, "MP no longer unassigned", "employee_id")
    resolve_missing("IDLE_UNASSIGNED", ids, "MP no longer unassigned", "employee_id")

    # 5. device offline
    for d in x.rows("SELECT * FROM devices WHERE is_active=1 AND adapter <> 'manual'"):
        last = parse_ts(d["last_heartbeat_at"] or d["created_at"])
        if last + mins(dev_m) <= now:
            when = parse_ts(d["last_heartbeat_at"]).astimezone(tz).strftime("%d %b %H:%M") if d["last_heartbeat_at"] else "never"
            raise_alert(x, "DEVICE_OFFLINE", "CRITICAL", None, "device", d["id"], f"DEVICE_OFFLINE:{d['id']}",
                        f"Gate device offline: {d['name']}", f"No heartbeat since {when}", now)
            n_raised += 1

    # 6a. nobody punched OUT for `auto_out_hours` after shift start -> automatic OUT (before the missing-checkout alert below)
    n_raised += auto_missed_punch_out(x, now)

    # 6. missing checkout
    open_att = x.rows("SELECT a.id, a.employee_id, e.full_name, e.employee_code FROM shift_attendance a "
                      "JOIN employees e ON e.id=a.employee_id JOIN mp_current_state s ON s.employee_id=a.employee_id "
                      "WHERE a.checked_out_at IS NULL AND s.presence='INSIDE'")
    for a in open_att:
        end = shift_end_at(x, a["id"])
        if end and end + mins(chk) <= now:
            raise_alert(x, "MISSING_CHECKOUT", "WARNING", a["employee_id"], "attendance", a["id"], f"MISSING_CHECKOUT:{a['id']}",
                        f"{a['full_name']} ({a['employee_code']}): still inside after shift end",
                        f"Shift ended {end.astimezone(tz).strftime('%H:%M')}; no gate OUT recorded", now)
            n_raised += 1
    still_open = {r["id"] for r in x.rows("SELECT id FROM shift_attendance WHERE checked_out_at IS NULL")}
    resolve_missing("MISSING_CHECKOUT", still_open, "Checked out")
    return ok(raised_or_refreshed=n_raised, at=iso(now))


def purge_employees(x: Ctx, ids: list[str]) -> int:
    """Remove employees together with everything recorded about them (admin only; audit log keeps the record of the delete)."""
    if not ids:
        return 0
    n = 0
    for i in range(0, len(ids), 400):                  # SQLite parameter limit
        part = ids[i:i + 400]
        q = ",".join("?" * len(part))
        x.ex("UPDATE meta SET value='1' WHERE key='purge_demo'")   # opens the append-only logs for this delete only
        hids = [r["id"] for r in x.rows(f"SELECT id FROM handover_records WHERE handing_employee_id IN ({q})", part)]
        hq = ",".join("?" * len(hids)) or "''"
        for sql, p in [
            (f"DELETE FROM alerts WHERE employee_id IN ({q})", part),
            (f"DELETE FROM mp_current_state WHERE employee_id IN ({q})", part),
            (f"DELETE FROM movement_events WHERE employee_id IN ({q})", part),
            (f"DELETE FROM handover_events WHERE handover_id IN ({hq})", hids),
            (f"DELETE FROM handover_items WHERE handover_id IN ({hq})", hids),
            (f"UPDATE handover_items SET received_by_employee_id=NULL WHERE received_by_employee_id IN ({q})", part),
            (f"UPDATE handover_records SET received_by_employee_id=NULL WHERE received_by_employee_id IN ({q})", part),
            (f"DELETE FROM handover_records WHERE id IN ({hq})", hids),
            (f"DELETE FROM break_records WHERE employee_id IN ({q})", part),
            (f"DELETE FROM pickup_assignments WHERE employee_id IN ({q})", part),
            (f"DELETE FROM work_assignments WHERE employee_id IN ({q})", part),
            (f"DELETE FROM shift_attendance WHERE employee_id IN ({q})", part),
            (f"DELETE FROM gate_events WHERE employee_id IN ({q})", part),
            (f"DELETE FROM correction_requests WHERE employee_id IN ({q})", part),
            (f"DELETE FROM area_transfers WHERE employee_id IN ({q})", part),
            (f"DELETE FROM exit_permits WHERE employee_id IN ({q})", part),
            (f"DELETE FROM face_templates WHERE employee_id IN ({q})", part),
            (f"DELETE FROM request_log WHERE user_id IN (SELECT id FROM users WHERE employee_id IN ({q}))", part),
            (f"DELETE FROM users WHERE employee_id IN ({q})", part),
            (f"DELETE FROM employees WHERE id IN ({q})", part),
        ]:
            x.ex(sql, p)
        x.ex("UPDATE meta SET value='0' WHERE key='purge_demo'")
        n += len(part)
    x.ex("INSERT INTO meta(key, value) VALUES ('face_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")
    return n


def purge_demo_data(x: Ctx, a: dict) -> dict:
    require(x.has("admin"), x, "purge_demo_data")
    n = purge_employees(x, [r["id"] for r in x.rows("SELECT id FROM employees WHERE is_demo=1")])
    if n:
        audit(x, "DEMO_PURGE", "employees", None, "Demo data purged", None, {"employees": n})
    return ok(purged=n)


# Mutating actions callable via POST /api/rpc/<name>
RPC = {f.__name__: f for f in [
    kiosk_gate_scan, assign_work, unassign_work, start_break, end_break, plan_pickup, cancel_pickup,
    manual_gate_correction, override_mp_state, decide_correction, acknowledge_alert, resolve_alert,
    create_handover, add_handover_items, start_handover, accept_handover, verify_handover, dispute_handover,
    resolve_handover_dispute, cancel_handover, set_handover_pending_reason, purge_demo_data,
]}
