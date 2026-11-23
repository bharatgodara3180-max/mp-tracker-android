"""Area handover / takeover of an MP between supervisors.

Supervisor of area A scans an MP working in A and hands him over to area B (PENDING).
The supervisor working in area B sees it under notifications and receives it (takeover);
only then the MP is deployed in B. No MP moves between areas without this handover + takeover.
"""
from __future__ import annotations

from . import face
from .db import new_id, now_iso, utcnow
from .engine import AppError, BadInput, Ctx, NotFound, assign_work, audit, require

ROLES = ("admin", "supervisor")


def _area(x: Ctx, aid: str | None, label: str) -> dict:
    a = x.one("SELECT id, code, name, out_purpose FROM areas WHERE id=? AND is_active=1", (aid,))   # any active area, incl. OUT areas (Pickup / Lunch)
    if not a:
        raise NotFound(f"{label} area nahi mila — page refresh karke dobara chuniye")
    return a


def _name(a: dict) -> str:
    return f"{a['name']} ({a['code']})"


def create(x: Ctx, a: dict) -> dict:
    require(x.has(*ROLES), x, "transfer_create")
    src = _area(x, a.get("from_area_id"), "Your")
    dst = _area(x, a.get("to_area_id"), "Target")
    if src["id"] == dst["id"]:
        raise BadInput("Dono area same hain — doosra area chuniye")
    emp, reason, info, not_found = face._identify(x, a)
    e = face._employee(x, emp)
    R = face.result
    if not emp:
        return {"ok": True, "matched": False, "employee": None, "result": R(not_found, reason or "", "red", True)}
    s = x.one("SELECT status, presence, assignment_id FROM mp_current_state WHERE employee_id=?", (emp,))
    cur = x.one("SELECT area_id FROM work_assignments WHERE id=?", (s["assignment_id"],)) if s["assignment_id"] else None
    pend = x.one("SELECT t.id, ar.name FROM area_transfers t JOIN areas ar ON ar.id = t.to_area_id "
                 "WHERE t.employee_id=? AND t.status='PENDING'", (emp,))
    if s["presence"] != "INSIDE":
        res = R("DC IN NAHI HUA", "MP DC ke andar nahi hai", "red", True)
    elif s["status"] in ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL", "OUTSIDE_OTHER", "OUTSIDE_BREAK"):
        res = R("HANDOVER NAHI HO SAKTA", "MP abhi DC ke bahar hai — wapas aane ke baad", "red", True)
    elif (po := face.pending_out(x, emp, utcnow())) and po["from_area_id"] != src["id"]:
        # assigned for pickup / lunch: only the area that gave that OUT may hand him over
        res = R("HANDOVER NAHI HO SAKTA", f"MP {po['out_name']} ke liye assign hai — jisne bheja wahi area handover de sakta hai", "red", True)
    elif pend:
        res = R("PEHLE SE HANDOVER", f"{pend['name']} ke liye handover pending hai", "amber")
    elif not (s["status"] == "WORKING" and cur and cur["area_id"] == src["id"]):
        where = x.one("SELECT name FROM areas WHERE id=?", (cur["area_id"],))["name"] if cur else None
        res = R("HANDOVER NAHI HO SAKTA", f"MP {_name(src)} mein deploy nahi hai" + (f" (abhi {where} mein)" if where else ""), "red", True)
    else:
        tid = new_id()
        x.ex("INSERT INTO area_transfers(id, employee_id, from_area_id, to_area_id, status, created_by, created_at) "
             "VALUES (?,?,?,?, 'PENDING', ?, ?)", (tid, emp, src["id"], dst["id"], x.uid, now_iso()))
        audit(x, "AREA_HANDOVER_GIVEN", "employees", emp, None, None, {"transfer": tid, "from": src["code"], "to": dst["code"]})
        res = R("HANDOVER DIYA", f"{src['name']} → {dst['name']} · receive hone tak MP {src['name']} mein rahega", "blue")
    return {"ok": True, "matched": True, "employee": e, "result": res, "match": info}


def listing(x: Ctx, area_id: str | None, direction: str) -> list[dict]:
    require(x.has(*ROLES, "ops_manager"), x, "transfer_list")
    col = "to_area_id" if direction == "incoming" else "from_area_id"
    rows = x.rows(f"""SELECT t.id, t.employee_id, e.employee_code, e.full_name, t.from_area_id, fa.name AS from_area, fa.code AS from_code,
                        t.to_area_id, ta.name AS to_area, ta.code AS to_code, t.created_at, u.full_name AS given_by
                      FROM area_transfers t JOIN employees e ON e.id = t.employee_id
                      JOIN areas fa ON fa.id = t.from_area_id JOIN areas ta ON ta.id = t.to_area_id
                      LEFT JOIN users u ON u.id = t.created_by
                      WHERE t.status='PENDING' AND t.{col}=? ORDER BY t.created_at""", (area_id,))
    for r in rows:
        r["has_photo"] = (face.photo_dir() / f"{r['employee_id']}.jpg").exists()
    return rows


def _pending(x: Ctx, tid: str, area_id: str | None) -> dict:
    t = x.one("SELECT * FROM area_transfers WHERE id=?", (tid,))
    if not t:
        raise NotFound("Handover not found")
    if t["status"] != "PENDING":
        raise BadInput(f"Ye handover pehle hi {t['status'].lower()} ho chuka hai")
    if t["to_area_id"] != area_id:
        raise BadInput("Ye handover aapke area ke liye nahi hai")
    return t


def receive(x: Ctx, tid: str, a: dict) -> dict:
    require(x.has(*ROLES), x, "transfer_receive", transfer=tid)
    t = _pending(x, tid, a.get("area_id"))
    dst = _area(x, t["to_area_id"], "Target")
    s = x.one("SELECT status, presence, assignment_id FROM mp_current_state WHERE employee_id=?", (t["employee_id"],))
    cur = x.one("SELECT area_id FROM work_assignments WHERE id=?", (s["assignment_id"],)) if s["assignment_id"] else None
    e = face._employee(x, t["employee_id"])
    R = face.result
    po = face.pending_out(x, t["employee_id"], utcnow())
    if po and po["from_area_id"] != t["from_area_id"]:
        return {"ok": True, "employee": e, "result": R("TAKEOVER NAHI HUA", f"MP {po['out_name']} ke liye assign hai — wo cancel hone ke baad hi", "red", True)}
    if s["presence"] != "INSIDE" or s["status"] not in ("WORKING", "INSIDE_UNASSIGNED"):
        x.ex("UPDATE area_transfers SET status='CANCELLED', decided_by=?, decided_at=?, note=? WHERE id=?",
             (x.uid, now_iso(), f"MP status changed: {s['status']}", tid))
        return {"ok": True, "employee": e, "result": R("HANDOVER CANCEL", f"MP ab {s['status']} hai — dobara handover lijiye", "red", True)}
    if dst["out_purpose"] and po:
        return {"ok": True, "employee": e, "result": R("TAKEOVER NAHI HUA", f"MP pehle se {po['out_name']} ke liye assign hai", "red", True)}
    if dst["out_purpose"]:
        # OUT area (Pickup / Lunch / Other): receiving = assigning that OUT to the MP, from the area he is working in
        emp_row = x.one("SELECT employee_code FROM employees WHERE id=?", (t["employee_id"],))
        r = face.assign_out(x, {"out_area_id": dst["id"], "scan_value": emp_row["employee_code"],
                                "_deploy_area": cur["area_id"] if cur else None})
        if r["result"]["alarm"]:
            return {"ok": True, "employee": e, "result": R("TAKEOVER NAHI HUA", r["result"]["sub"] or r["result"]["label"], "red", True)}
        x.ex("UPDATE area_transfers SET status='ACCEPTED', decided_by=?, decided_at=? WHERE id=?", (x.uid, now_iso(), tid))
        audit(x, "AREA_HANDOVER_RECEIVED", "employees", t["employee_id"], None, None, {"transfer": tid, "to": dst["code"]})
        return {"ok": True, "employee": e, "result": R("TAKEOVER HO GAYA", f"{_name(dst)} ke liye OUT assign ho gaya")}
    try:
        if not (s["status"] == "WORKING" and cur and cur["area_id"] == dst["id"]):
            assign_work(x, {"p_employee_id": t["employee_id"], "p_area_id": dst["id"], "p_supervisor_user_id": x.uid,
                            "p_reason": "Area handover received"})
    except AppError as err:
        return {"ok": True, "employee": e, "result": R("TAKEOVER NAHI HUA", err.message, "red", True)}
    if po:                 # the area that gave the pickup / lunch handed him over: that OUT ends now, he is in the new area
        face.cancel_out(x, po, "Handover to another area")
    x.ex("UPDATE area_transfers SET status='ACCEPTED', decided_by=?, decided_at=? WHERE id=?", (x.uid, now_iso(), tid))
    audit(x, "AREA_HANDOVER_RECEIVED", "employees", t["employee_id"], None, None, {"transfer": tid, "to": dst["code"]})
    return {"ok": True, "employee": e, "result": R("TAKEOVER HO GAYA", f"MP ab {_name(dst)} mein deploy hai")}


def reject(x: Ctx, tid: str, a: dict) -> dict:
    require(x.has(*ROLES), x, "transfer_reject", transfer=tid)
    t = _pending(x, tid, a.get("area_id"))
    x.ex("UPDATE area_transfers SET status='REJECTED', decided_by=?, decided_at=?, note=? WHERE id=?",
         (x.uid, now_iso(), (a.get("note") or "")[:200] or None, tid))
    audit(x, "AREA_HANDOVER_REJECTED", "employees", t["employee_id"], None, None, {"transfer": tid})
    return {"ok": True}


def deployed_in_other_area(x: Ctx, emp: str, area_id: str) -> str | None:
    """Area name if the MP is working somewhere else (then deploy needs a handover)."""
    r = x.one("""SELECT ar.name FROM mp_current_state s JOIN work_assignments w ON w.id = s.assignment_id
                 JOIN areas ar ON ar.id = w.area_id WHERE s.employee_id=? AND s.status='WORKING' AND w.area_id <> ?""", (emp, area_id))
    return r["name"] if r else None


