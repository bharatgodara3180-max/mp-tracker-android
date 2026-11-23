"""Early leave: a supervisor raises a request for an MP (employee ID + reason); Ops Manager / Admin approve or reject it.
An approved request lets that MP scan OUT at the gate once (counted as an early leave, same device checks as a normal shift-end OUT)."""
from __future__ import annotations

from datetime import timedelta

from .db import iso, new_id, now_iso, utcnow
from .engine import BadInput, Conflict, Ctx, NotFound, audit, auto_resolve, employee_by_scan, raise_alert, require

VALID_HOURS = 12   # an approved request that was not used within this time lapses

_DDL = ("CREATE TABLE IF NOT EXISTS early_leave_requests (id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, reason TEXT NOT NULL, "
        "requested_by TEXT, requested_by_name TEXT, requested_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', "
        "decided_by TEXT, decided_by_name TEXT, decided_at TEXT, decision_note TEXT, used_at TEXT, gate_event_id TEXT)")


def ensure(c) -> None:
    c.execute(_DDL)


def _key(rid: str) -> str:
    return f"EARLY_LEAVE:{rid}"


def create(x: Ctx, a: dict) -> dict:
    require(x.has("admin", "supervisor"), x, "early_leave_request")
    code = str(a.get("emp_id") or a.get("scan_value") or "").strip()
    reason = str(a.get("reason") or "").strip()
    if not code:
        raise BadInput("Employee ID likhiye")
    if len(reason) < 3:
        raise BadInput("Reason likhiye")
    emp = employee_by_scan(x, code)
    e = x.one("SELECT id, employee_code, full_name FROM employees WHERE id=?", (emp,)) if emp else None
    if not e:
        raise NotFound(f"'{code}' kisi active employee ka ID nahi hai")
    if x.one("SELECT 1 FROM early_leave_requests WHERE employee_id=? AND status IN ('PENDING','APPROVED') AND used_at IS NULL", (e["id"],)):
        raise Conflict(f"{e['full_name']} ki early leave request pehle se chal rahi hai")
    me = x.one("SELECT username, full_name FROM users WHERE id=?", (x.uid,)) if x.uid else None
    who = (me or {}).get("full_name") or (me or {}).get("username") or "supervisor"
    rid = new_id()
    x.ex("INSERT INTO early_leave_requests(id, employee_id, reason, requested_by, requested_by_name, requested_at) VALUES (?,?,?,?,?,?)",
         (rid, e["id"], reason[:300], x.uid, who, now_iso()))
    raise_alert(x, "EARLY_LEAVE_REQUEST", "WARNING", e["id"], "early_leave", rid, _key(rid),
                f"Early leave request: {e['full_name']} ({e['employee_code']})",
                f"{reason[:300]} · requested by {who} · approve / reject: /early-leave.html (Ops Manager / Admin)")
    audit(x, "early_leave_request", "employee", e["id"], reason[:300], None, {"request": rid})
    return {"ok": True, "id": rid, "employee": {"emp_id": e["employee_code"], "name": e["full_name"]}}


def _rows(x: Ctx, where: str, args: tuple = ()) -> list[dict]:
    return x.rows("SELECT r.*, e.employee_code, e.full_name, e.designation FROM early_leave_requests r "
                  "JOIN employees e ON e.id = r.employee_id " + where + " ORDER BY r.requested_at DESC LIMIT 100", args)


def listing(x: Ctx) -> dict:
    """Ops Manager / Admin: pending + last 24 h decided. Supervisor: his own requests (last 24 h)."""
    since = iso(utcnow() - timedelta(hours=24))
    if x.has("admin", "ops_manager"):
        rows = _rows(x, "WHERE r.status='PENDING' OR r.requested_at >= ?", (since,))
    elif x.has("supervisor"):
        rows = _rows(x, "WHERE r.requested_by=? AND r.requested_at >= ?", (x.uid, since))
    else:
        rows = []
    return {"ok": True, "rows": rows, "can_decide": bool(x.has("admin", "ops_manager"))}


def decide(x: Ctx, rid: str, approve: bool, note: str = "") -> dict:
    require(x.has("admin", "ops_manager"), x, "early_leave_decide")
    r = x.one("SELECT * FROM early_leave_requests WHERE id=?", (rid,))
    if not r:
        raise NotFound("Request nahi mili")
    if r["status"] != "PENDING":
        raise Conflict(f"Ye request pehle se {r['status']} hai")
    me = x.one("SELECT username, full_name FROM users WHERE id=?", (x.uid,)) if x.uid else None
    who = (me or {}).get("full_name") or (me or {}).get("username") or ""
    x.ex("UPDATE early_leave_requests SET status=?, decided_by=?, decided_by_name=?, decided_at=?, decision_note=? WHERE id=?",
         ("APPROVED" if approve else "REJECTED", x.uid, who, now_iso(), (note or "")[:200], rid))
    auto_resolve(x, _key(rid), "Approved" if approve else "Rejected")
    audit(x, "early_leave_approve" if approve else "early_leave_reject", "employee", r["employee_id"], note or None, None, {"request": rid})
    return {"ok": True, "status": "APPROVED" if approve else "REJECTED"}


def approved_for(x: Ctx, emp: str, t) -> str | None:
    """Id of an approved, unused early-leave request for this MP (valid VALID_HOURS after the approval)."""
    r = x.one("SELECT id FROM early_leave_requests WHERE employee_id=? AND status='APPROVED' AND used_at IS NULL AND decided_at >= ? "
              "ORDER BY decided_at DESC LIMIT 1", (emp, iso(t - timedelta(hours=VALID_HOURS))))
    return r["id"] if r else None


def mark_used(x: Ctx, rid: str, t, gate_event_id: str | None) -> None:
    x.ex("UPDATE early_leave_requests SET used_at=?, gate_event_id=? WHERE id=?", (iso(t), gate_event_id, rid))
