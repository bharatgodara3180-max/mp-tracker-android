"""Read models for the dashboards and reports (role-filtered in Python)."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from .db import iso, parse_ts, utcnow
from .engine import Ctx, can_view, setting, site_tz, Forbidden

LIVE_SQL = """
SELECT e.id AS employee_id, e.employee_code, e.full_name, e.designation, e.is_demo,
  s.status, s.presence, s.status_since, s.version, s.updated_at,
  coalesce(att.shift_id, e.default_shift_id) AS shift_id, sh.code AS shift_code, sh.name AS shift_name,
  att.id AS attendance_id, att.business_date, att.checked_in_at,
  wa.id AS assignment_id, wa.area_id, ar.code AS area_code, ar.name AS area_name, ar.kind AS area_kind,
  wa.task AS current_task, wa.process, wa.started_at AS assignment_started_at,
  coalesce(wa.supervisor_user_id, e.default_supervisor_user_id) AS supervisor_user_id, sup.full_name AS supervisor_name,
  pk.id AS pickup_id, pk.status AS pickup_status, pk.purpose AS pickup_purpose, pk.route_ref, pk.destination AS pickup_destination,
  pk.departed_at, pk.expected_return_at, pk.out_area_id AS pickup_out_area_id,
  br.id AS break_id, br.break_type, br.location AS break_location, br.started_at AS break_started_at, br.allowed_minutes AS break_allowed_minutes,
  ho.id AS handover_id, ho.handover_no, ho.status AS handover_status, ho.handover_type, ho.pending_since AS handover_pending_since,
  ho.due_at AS handover_due_at, ho.completed_at AS handover_completed_at, ho.received_by_employee_id,
  rcv.full_name AS receiver_name, rcv.employee_code AS receiver_code,
  s.last_gate_event_id, s.last_gate_direction, s.last_gate_event_at, ge.source AS last_gate_source, s.expected_by,
  (SELECT count(*) FROM alerts al WHERE al.employee_id = e.id AND al.status <> 'RESOLVED') AS open_alerts
FROM employees e
JOIN mp_current_state s ON s.employee_id = e.id
LEFT JOIN shift_attendance att ON att.id = s.attendance_id
LEFT JOIN shifts sh ON sh.id = coalesce(att.shift_id, e.default_shift_id)
LEFT JOIN work_assignments wa ON wa.id = s.assignment_id
LEFT JOIN areas ar ON ar.id = wa.area_id
LEFT JOIN users sup ON sup.id = coalesce(wa.supervisor_user_id, e.default_supervisor_user_id)
LEFT JOIN pickup_assignments pk ON pk.id = (SELECT p.id FROM pickup_assignments p WHERE p.employee_id = e.id
                                            AND p.status IN ('PLANNED','OUT') ORDER BY p.planned_at DESC LIMIT 1)
LEFT JOIN break_records br ON br.id = s.break_id
-- current handover per MP. Written without outer columns in a subquery's ORDER BY / a LEFT JOIN's ON
-- clause: older SQLite (3.45/3.46, shipped with Windows Python) rejects those ("no such column").
LEFT JOIN (
    SELECT s2.employee_id AS eid, coalesce(
      (SELECT h.id FROM handover_records h WHERE h.id = s2.handover_id AND h.handing_employee_id = s2.employee_id),
      (SELECT h.id FROM handover_records h WHERE h.handing_employee_id = s2.employee_id
         AND (h.status IN ('PENDING','IN_PROGRESS','DISPUTED') OR h.pending_since >= coalesce(a2.checked_in_at, :since16))
       ORDER BY (h.status IN ('PENDING','IN_PROGRESS','DISPUTED')) DESC, h.pending_since DESC LIMIT 1)
    ) AS hid
    FROM mp_current_state s2 LEFT JOIN shift_attendance a2 ON a2.id = s2.attendance_id
  ) cur_ho ON cur_ho.eid = e.id
LEFT JOIN handover_records ho ON ho.id = cur_ho.hid
LEFT JOIN employees rcv ON rcv.id = ho.received_by_employee_id
LEFT JOIN gate_events ge ON ge.id = s.last_gate_event_id
WHERE e.is_active = 1
"""


def zone_of(status: str, area_code: str | None) -> str:
    if status == "WORKING":
        return area_code or "UNKNOWN"
    if status in ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL", "OUTSIDE_OTHER", "OUTSIDE_UNDECLARED"):
        return "OUTSIDE"
    if status in ("ON_BREAK", "OUTSIDE_BREAK"):
        return "BREAK"
    if status == "INSIDE_UNASSIGNED":
        return "UNASSIGNED"
    if status.startswith("HANDOVER"):
        return "HANDOVER"
    return "OFF"


def _visible(x: Ctx, rows: list[dict], key: str = "employee_id") -> list[dict]:
    if x.has("admin", "ops_manager", "gate_operator"):
        return rows
    if x.has("supervisor") and setting(x, "supervisor_visibility", "all") == "all":
        return rows
    return [r for r in rows if r.get(key) and can_view(x, r[key])]


def live_rows(x: Ctx, employee_id: str | None = None) -> list[dict]:
    now = utcnow()
    sql = LIVE_SQL + (" AND e.id = :emp" if employee_id else "") + " ORDER BY e.employee_code"
    out = x.rows(sql, {"since16": iso(now - timedelta(hours=16)), "emp": employee_id})
    for r in out:
        r["is_demo"] = bool(r["is_demo"])
        exp = parse_ts(r["expected_by"])
        r["delay_seconds"] = int((now - exp).total_seconds()) if exp and now > exp else 0
        r["seconds_in_status"] = max(0, int((now - parse_ts(r["status_since"])).total_seconds()))
        r["zone"] = zone_of(r["status"], r["area_code"])
    _mark_out(x, out, now)
    return _visible(x, out)


def _mark_out(x: Ctx, rows: list[dict], now: datetime) -> None:
    """out_state ASSIGNED (supervisor gave OUT, MP still inside) / OUT (gone out through the gate) + which OUT option."""
    opts = x.rows("SELECT id, name, out_purpose FROM areas WHERE out_purpose IS NOT NULL ORDER BY is_active DESC, name")
    names = {o["id"]: o["name"] for o in opts}
    first: dict[str, str] = {}
    for o in opts:
        first.setdefault(o["out_purpose"], o["id"])
    pending = {p["employee_id"]: p["out_area_id"] for p in x.rows(
        "SELECT employee_id, out_area_id FROM exit_permits WHERE status='PENDING' AND valid_until >= ? ORDER BY created_at", (iso(now),))}
    used = {p["employee_id"]: p["out_area_id"] for p in x.rows(
        "SELECT employee_id, out_area_id FROM exit_permits WHERE status='USED' AND used_at >= ? ORDER BY used_at",
        (iso(now - timedelta(hours=16)),))}
    for r in rows:
        st, area, purpose = None, None, None
        if r["pickup_status"] == "PLANNED" and r["presence"] == "INSIDE":
            st, area, purpose = "ASSIGNED", r["pickup_out_area_id"], r["pickup_purpose"]
        elif r["pickup_status"] == "OUT" and r["status"] in ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL", "OUTSIDE_OTHER"):
            st, area, purpose = "OUT", r["pickup_out_area_id"], r["pickup_purpose"]
        elif r["status"] == "OUTSIDE_BREAK":
            st, area, purpose = "OUT", used.get(r["employee_id"]), "LUNCH"
        elif r["employee_id"] in pending and r["presence"] == "INSIDE":
            st, area, purpose = "ASSIGNED", pending[r["employee_id"]], "LUNCH"
        if st and not area:
            area = first.get("OTHER" if purpose == "OFFICIAL" else purpose)
        r["out_state"], r["out_area_id"], r["out_area_name"] = st, area, names.get(area) if area else None


def handover_rows(x: Ctx, since: str | None = None, active_only: bool = False, hid: str | None = None) -> list[dict]:
    where = ["1=1"]
    p: list = []
    if hid:
        where.append("h.id = ?")
        p.append(hid)
    elif active_only:
        where.append("h.status IN ('PENDING','IN_PROGRESS')")
    elif since:
        where.append("(h.status IN ('PENDING','IN_PROGRESS','DISPUTED') OR h.pending_since >= ?)")
        p.append(since)
    out = x.rows(f"""
      SELECT h.*, he.employee_code AS handing_code, he.full_name AS handing_name, he.is_demo,
        re.employee_code AS receiver_code, re.full_name AS receiver_name, sa.name AS source_area_name, da.name AS destination_area_name,
        pk.route_ref, pk.destination AS pickup_destination, sup.full_name AS supervisor_name,
        he.default_supervisor_user_id AS supervisor_user_id,
        (SELECT count(*) FROM handover_items i WHERE i.handover_id = h.id) AS items_total,
        (SELECT count(*) FROM handover_items i WHERE i.handover_id = h.id AND i.status = 'ACCEPTED') AS items_accepted,
        (SELECT count(*) FROM handover_items i WHERE i.handover_id = h.id AND i.status = 'DISPUTED') AS items_disputed
      FROM handover_records h JOIN employees he ON he.id = h.handing_employee_id
      LEFT JOIN employees re ON re.id = h.received_by_employee_id
      LEFT JOIN areas sa ON sa.id = h.source_area_id LEFT JOIN areas da ON da.id = h.destination_area_id
      LEFT JOIN pickup_assignments pk ON pk.id = h.pickup_assignment_id
      LEFT JOIN users sup ON sup.id = he.default_supervisor_user_id
      WHERE {' AND '.join(where)} ORDER BY h.pending_since""", p)
    now = utcnow()
    for h in out:
        h["is_demo"] = bool(h["is_demo"])
        h["verification_required"] = bool(h["verification_required"])
        h["awaiting_verification"] = bool(h["verification_required"] and h["accepted_at"] and h["status"] == "IN_PROGRESS")
        h["is_overdue"] = bool(h["status"] in ("PENDING", "IN_PROGRESS") and h["due_at"] and now > parse_ts(h["due_at"]))
        end = parse_ts(h["completed_at"]) or now
        h["age_seconds"] = max(0, int((end - parse_ts(h["pending_since"])).total_seconds()))
        h["is_pickup_return"] = h["pickup_assignment_id"] is not None
    if x.has("mp"):
        me = x.my_emp
        return [h for h in out if h["handing_employee_id"] == me or h["received_by_employee_id"] == me
                or h["status"] in ("PENDING", "IN_PROGRESS")]
    return _visible(x, out, "handing_employee_id")


def shift_counts(x: Ctx, include_demo: bool = True) -> list[dict]:
    """Per shift: how many MPs came (DC IN) in the shift's current timing window = its business date today
    (a shift that crosses midnight still counts the evening before until its end time). Also the rostered strength."""
    local = utcnow().astimezone(site_tz(x))
    out = []
    for sh in x.rows("SELECT id, code, name, start_time, end_time FROM shifts WHERE is_active=1 ORDER BY start_time, code"):
        d = local.date()
        if str(sh["end_time"])[:5] <= str(sh["start_time"])[:5] and local.strftime("%H:%M") < str(sh["end_time"])[:5]:
            d -= timedelta(days=1)
        q = ("SELECT count(DISTINCT a.employee_id) AS n FROM shift_attendance a JOIN employees e ON e.id = a.employee_id "
             "WHERE a.shift_id=? AND a.business_date=?" + ("" if include_demo else " AND e.is_demo=0"))
        came = x.one(q, (sh["id"], d.isoformat()))["n"]
        roster = x.one("SELECT count(*) AS n FROM employees WHERE is_active=1 AND default_shift_id=?" + ("" if include_demo else " AND is_demo=0"),
                       (sh["id"],))["n"]
        out.append({"id": sh["id"], "code": sh["code"], "name": sh["name"], "start": str(sh["start_time"])[:5], "end": str(sh["end_time"])[:5],
                    "came": came, "roster": roster, "business_date": d.isoformat()})
    return out


def kpis(x: Ctx, shift_id: str | None = None, include_demo: bool = True) -> dict:
    # MPs whose shift has ended (OUT after shift end) are not counted on the live dashboard
    live = [r for r in live_rows(x) if (not shift_id or r["shift_id"] == shift_id) and (include_demo or not r["is_demo"])
            and r["status"] != "SHIFT_ENDED"]
    ids = {r["employee_id"] for r in live}
    ho = [h for h in handover_rows(x, active_only=True) if h["handing_employee_id"] in ids]
    on = [r for r in live if r["status"] not in ("NOT_CHECKED_IN", "SHIFT_ENDED")]
    w = [r for r in live if r["status"] == "WORKING" and r["out_state"] != "ASSIGNED"]   # OUT-assigned MPs count only there
    return {
        "total_on_shift": len(on),
        "inside": sum(1 for r in on if r["presence"] == "INSIDE"),
        "outside": sum(1 for r in live if r["status"].startswith("OUTSIDE")),
        "on_pickup": sum(1 for r in live if r["status"] == "OUTSIDE_PICKUP"),
        "on_break": sum(1 for r in live if r["status"] in ("ON_BREAK", "OUTSIDE_BREAK")),
        "areas": [{**a,
                   "working": sum(1 for r in w if r["area_id"] == a["id"]),
                   "assigned": sum(1 for r in live if r["out_state"] == "ASSIGNED" and r["out_area_id"] == a["id"]),
                   "out": sum(1 for r in live if r["out_state"] == "OUT" and r["out_area_id"] == a["id"])}
                  for a in x.rows("SELECT id, code, name, kind, out_purpose FROM areas WHERE is_active=1 "
                                  "ORDER BY (out_purpose IS NOT NULL), name")],
        "primary": sum(1 for r in w if r["area_kind"] == "PRIMARY"),
        "secondary": sum(1 for r in w if r["area_kind"] == "SECONDARY"),
        "staging": sum(1 for r in w if r["area_kind"] == "STAGING"),
        "dock": sum(1 for r in w if r["area_kind"] == "DOCK"),
        "other_blocks": sum(1 for r in w if r["area_kind"] not in ("PRIMARY", "SECONDARY", "STAGING", "DOCK")),   # BLOCK, OTHER, custom kinds
        "handover_pending": len(ho),
        "handover_overdue": sum(1 for h in ho if h["is_overdue"]),
        "unassigned": sum(1 for r in live if r["status"] == "INSIDE_UNASSIGNED" and r["out_state"] != "ASSIGNED"),
        "exceptions": sum(1 for r in live if r["open_alerts"] > 0 or r["delay_seconds"] > 0
                          or r["status"] in ("OUTSIDE_UNDECLARED", "HANDOVER_DISPUTED")),
        "not_checked_in": sum(1 for r in live if r["status"] == "NOT_CHECKED_IN"),
        "shifts": shift_counts(x, include_demo),
        "computed_at": iso(utcnow()),
    }


GATE_LOG_SQL = """SELECT g.id, g.event_time, g.received_at, g.direction, g.source, g.purpose, g.processing_status, g.processing_note,
  g.match_confidence, g.person_ref, g.reason, g.corrects_event_id, g.employee_id, e.employee_code, e.full_name, e.is_demo,
  g.device_id, d.device_code, d.name AS device_name,
  CASE WHEN json_valid(g.raw_payload) THEN json_extract(g.raw_payload, '$.snapshot') END AS snapshot
  FROM gate_events g LEFT JOIN employees e ON e.id = g.employee_id LEFT JOIN devices d ON d.id = g.device_id"""


def gate_log(x: Ctx, limit: int = 500, employee_id: str | None = None, since: str | None = None) -> list[dict]:
    where, p = [], []
    if employee_id:
        where.append("g.employee_id = ?")
        p.append(employee_id)
    if since:
        where.append("g.event_time >= ?")
        p.append(since)
    sql = GATE_LOG_SQL + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY g.event_time DESC LIMIT ?"
    out = x.rows(sql, (*p, limit))
    if x.has("mp"):
        return [g for g in out if g["employee_id"] == x.my_emp]
    known = _visible(x, [g for g in out if g["employee_id"]])
    return sorted(known + [g for g in out if not g["employee_id"]], key=lambda g: g["event_time"], reverse=True)


def profile(x: Ctx, emp: str, hours: int = 24) -> dict:
    if not can_view(x, emp):
        raise Forbidden("view_profile", {"employee_id": emp})
    since = iso(utcnow() - timedelta(hours=hours))
    live = live_rows(x, emp)
    timeline = x.rows("""SELECT m.id, m.event_type, m.from_status, m.to_status, m.presence, a.name AS area, m.started_at AS at,
        m.reason, u.full_name AS actor, m.gate_event_id FROM movement_events m LEFT JOIN areas a ON a.id = m.area_id
        LEFT JOIN users u ON u.id = m.actor_user_id WHERE m.employee_id = ? AND m.started_at >= ? ORDER BY m.started_at, m.id""", (emp, since))
    assignments = x.rows("""SELECT w.id, a.name AS area, w.task, w.started_at, w.ended_at, w.end_reason FROM work_assignments w
        JOIN areas a ON a.id = w.area_id WHERE w.employee_id = ? AND coalesce(w.ended_at, '9999') >= ? ORDER BY w.started_at DESC""", (emp, since))
    now = utcnow()
    for w in assignments:
        w["minutes"] = round(((parse_ts(w["ended_at"]) or now) - parse_ts(w["started_at"])).total_seconds() / 60, 1)
    hos = [h for h in handover_rows(x, since=since)
           if (h["handing_employee_id"] == emp or h["received_by_employee_id"] == emp)]
    return {
        "live": live[0] if live else None,
        "timeline": timeline,
        "gate_events": gate_log(x, 500, emp, since),
        "assignments": assignments,
        "handovers": sorted(hos, key=lambda h: h["pending_since"], reverse=True),
        "breaks": x.rows("SELECT * FROM break_records WHERE employee_id = ? AND coalesce(ended_at, '9999') >= ? ORDER BY started_at DESC", (emp, since)),
        "pickups": x.rows("SELECT * FROM pickup_assignments WHERE employee_id = ? AND planned_at >= ? ORDER BY planned_at DESC", (emp, since)),
        "alerts": x.rows("SELECT * FROM alerts WHERE employee_id = ? AND first_detected_at >= ? ORDER BY first_detected_at DESC", (emp, since)),
    }


def alerts(x: Ctx, show: str = "open") -> list[dict]:
    if not x.has("admin", "ops_manager", "supervisor", "gate_operator"):
        return []
    if show == "open":
        out = x.rows("SELECT * FROM alerts WHERE status <> 'RESOLVED' ORDER BY first_detected_at DESC LIMIT 500")
    else:
        out = x.rows("SELECT * FROM alerts WHERE status = 'RESOLVED' AND resolved_at >= ? ORDER BY first_detected_at DESC LIMIT 500",
                     (iso(utcnow() - timedelta(hours=24)),))
    for a in out:
        a["auto_resolved"] = bool(a["auto_resolved"])
    return [a for a in out if a["employee_id"] is None or not x.has("supervisor") or can_view(x, a["employee_id"])]


# ---------------------------------------------------------------- reports
def _utc_range(x: Ctx, d_from: str, d_to: str) -> tuple[str, str]:
    tz = site_tz(x)
    start = datetime.combine(date.fromisoformat(d_from), datetime.min.time(), tzinfo=tz)
    end = datetime.combine(date.fromisoformat(d_to) + timedelta(days=1), datetime.min.time(), tzinfo=tz)
    return iso(start), iso(end)  # type: ignore[return-value]


def _m(a: datetime | None, b: datetime | None) -> float | None:
    if a is None or b is None:
        return None
    return round((b - a).total_seconds() / 60, 1)


def report(x: Ctx, name: str, d_from: str, d_to: str) -> list[dict]:
    if not x.has("admin", "ops_manager", "supervisor"):
        return []
    if name == "report_corrections" and not x.has("admin", "ops_manager"):
        return []
    lo, hi = _utc_range(x, d_from, d_to)
    now = utcnow()

    if name == "report_attendance":
        atts = x.rows("""SELECT a.*, e.employee_code, e.full_name, e.is_demo, sh.code AS shift_code, sh.start_time AS shift_start FROM shift_attendance a
            JOIN employees e ON e.id = a.employee_id LEFT JOIN shifts sh ON sh.id = a.shift_id
            WHERE a.business_date BETWEEN ? AND ? ORDER BY a.business_date, e.employee_code""", (d_from, d_to))
        out = []
        for a in _visible(x, atts):
            ws, we = parse_ts(a["checked_in_at"]), parse_ts(a["checked_out_at"]) or now
            ev = x.rows("SELECT to_status, presence, started_at FROM movement_events WHERE employee_id = ? AND started_at < ? "
                        "ORDER BY started_at, id", (a["employee_id"], iso(we)))
            acc = dict(inside=0.0, outside=0.0, working=0.0, unassigned=0.0, pickup=0.0, brk=0.0, handover=0.0)
            for i, e in enumerate(ev):
                s0 = parse_ts(e["started_at"])
                s1 = parse_ts(ev[i + 1]["started_at"]) if i + 1 < len(ev) else now
                lo_t, hi_t = max(s0, ws), min(s1, we)
                if hi_t <= lo_t:
                    continue
                m = (hi_t - lo_t).total_seconds() / 60
                st = e["to_status"]
                if e["presence"] == "INSIDE":
                    acc["inside"] += m
                elif e["presence"] == "OUTSIDE" and st != "SHIFT_ENDED":
                    acc["outside"] += m
                if st == "WORKING":
                    acc["working"] += m
                elif st == "INSIDE_UNASSIGNED":
                    acc["unassigned"] += m
                elif st in ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL", "OUTSIDE_OTHER"):
                    acc["pickup"] += m
                elif st in ("ON_BREAK", "OUTSIDE_BREAK"):
                    acc["brk"] += m
                elif st.startswith("HANDOVER"):
                    acc["handover"] += m
            late_in = ""
            if a["shift_start"]:   # DC IN later than shift start + grace (default 15 min)
                hh, mm = str(a["shift_start"]).split(":")[:2]
                st = datetime.combine(date.fromisoformat(a["business_date"]), datetime.min.time().replace(hour=int(hh), minute=int(mm)), tzinfo=site_tz(x))
                lm = (ws - st).total_seconds() / 60
                if lm > int(setting(x, "dc_late_grace_minutes", 15)):
                    late_in = f"Late IN {int(lm)} min"
            out.append({"attendance_id": a["id"], "employee_code": a["employee_code"], "full_name": a["full_name"],
                        "shift_code": a["shift_code"], "late_in": late_in, "business_date": a["business_date"], "checked_in_at": a["checked_in_at"],
                        "checked_out_at": a["checked_out_at"],
                        "remarks": "" if a["check_out_reason"] in (None, "GATE_OUT") else a["check_out_reason"],
                        "total_minutes": _m(ws, we),
                        "inside_minutes": round(acc["inside"], 1), "outside_minutes": round(acc["outside"], 1),
                        "working_minutes": round(acc["working"], 1), "unassigned_minutes": round(acc["unassigned"], 1),
                        "pickup_minutes": round(acc["pickup"], 1), "break_minutes": round(acc["brk"], 1),
                        "handover_minutes": round(acc["handover"], 1), "is_demo": bool(a["is_demo"])})
        return out

    if name == "report_pickups":
        rs = x.rows("""SELECT p.*, e.employee_code, e.full_name, e.is_demo,
            (SELECT h.status FROM handover_records h WHERE h.pickup_assignment_id = p.id ORDER BY h.pending_since DESC LIMIT 1) AS handover_status
            FROM pickup_assignments p JOIN employees e ON e.id = p.employee_id WHERE p.planned_at >= ? AND p.planned_at < ? ORDER BY p.planned_at""", (lo, hi))
        out = []
        for p in _visible(x, rs):
            end = parse_ts(p["returned_at"]) or (now if p["status"] == "OUT" else None)
            d = _m(parse_ts(p["expected_return_at"]), end)
            out.append({"pickup_id": p["id"], "employee_code": p["employee_code"], "full_name": p["full_name"], "purpose": p["purpose"],
                        "destination": p["destination"], "route_ref": p["route_ref"], "client_name": p["client_name"], "status": p["status"],
                        "planned_at": p["planned_at"], "departed_at": p["departed_at"], "returned_at": p["returned_at"],
                        "expected_return_at": p["expected_return_at"], "duration_minutes": _m(parse_ts(p["departed_at"]), end),
                        "delay_minutes": max(0.0, d) if d is not None else None, "handover_status": p["handover_status"],
                        "is_demo": bool(p["is_demo"])})
        return out

    if name == "report_breaks":
        rs = x.rows("""SELECT b.*, e.employee_code, e.full_name, e.is_demo FROM break_records b JOIN employees e ON e.id = b.employee_id
            WHERE b.started_at >= ? AND b.started_at < ? ORDER BY b.started_at""", (lo, hi))
        out = []
        for b in _visible(x, rs):
            dur = _m(parse_ts(b["started_at"]), parse_ts(b["ended_at"]) or now) or 0
            out.append({"break_id": b["id"], "employee_code": b["employee_code"], "full_name": b["full_name"], "break_type": b["break_type"],
                        "location": b["location"], "started_at": b["started_at"], "ended_at": b["ended_at"], "duration_minutes": dur,
                        "allowed_minutes": b["allowed_minutes"], "exceeded_minutes": round(max(0.0, dur - b["allowed_minutes"]), 1),
                        "is_demo": bool(b["is_demo"])})
        return out

    if name == "report_handovers":
        out = []
        for h in handover_rows(x, since=lo):
            if not (lo <= h["pending_since"] < hi):
                continue
            end = parse_ts(h["completed_at"]) or (now if h["status"] in ("PENDING", "IN_PROGRESS") else None)
            d = _m(parse_ts(h["due_at"]), end)
            out.append({"handover_id": h["id"], "handover_no": h["handover_no"], "handover_type": h["handover_type"], "mode": h["mode"],
                        "status": h["status"], "handing_code": h["handing_code"], "handing_name": h["handing_name"],
                        "receiver_code": h["receiver_code"], "receiver_name": h["receiver_name"],
                        "source": h["source_area_name"] or h["source_label"], "destination_area": h["destination_area_name"],
                        "supervisor_name": h["supervisor_name"], "pending_since": h["pending_since"], "started_at": h["started_at"],
                        "completed_at": h["completed_at"], "due_at": h["due_at"],
                        "minutes_to_complete": _m(parse_ts(h["pending_since"]), parse_ts(h["completed_at"])),
                        "delay_minutes": max(0.0, d) if d is not None else None, "items_total": h["items_total"],
                        "items_disputed": h["items_disputed"], "discrepancy_remarks": h["discrepancy_remarks"],
                        "pending_reason": h["pending_reason"], "verified": h["verified_at"] is not None, "is_demo": h["is_demo"]})
        return out

    if name in ("report_assignments", "report_area_deployment"):
        rs = x.rows("""SELECT w.*, e.employee_code, e.full_name, e.is_demo, a.name AS area_name, a.kind AS area_kind, a.sort_order,
            fa.name AS transferred_from_area, u.full_name AS assigned_by_name FROM work_assignments w
            JOIN employees e ON e.id = w.employee_id JOIN areas a ON a.id = w.area_id
            LEFT JOIN work_assignments f ON f.id = w.transfer_from_assignment_id LEFT JOIN areas fa ON fa.id = f.area_id
            LEFT JOIN users u ON u.id = w.assigned_by WHERE w.started_at >= ? AND w.started_at < ? ORDER BY w.started_at""", (lo, hi))
        rs = _visible(x, rs)
        for w in rs:
            w["minutes"] = _m(parse_ts(w["started_at"]), parse_ts(w["ended_at"]) or now)
        if name == "report_assignments":
            return [{"assignment_id": w["id"], "employee_code": w["employee_code"], "full_name": w["full_name"], "area_name": w["area_name"],
                     "area_kind": w["area_kind"], "task": w["task"], "started_at": w["started_at"], "ended_at": w["ended_at"],
                     "minutes": w["minutes"], "end_reason": w["end_reason"], "transferred_from_area": w["transferred_from_area"],
                     "assigned_by_name": w["assigned_by_name"], "is_demo": bool(w["is_demo"])} for w in rs]
        tz = site_tz(x)
        groups: dict[tuple, dict] = {}
        for w in rs:
            k = (parse_ts(w["started_at"]).astimezone(tz).date().isoformat(), w["area_name"], w["area_kind"], w["sort_order"])
            g = groups.setdefault(k, {"emps": set(), "n": 0, "tr": 0, "mins": 0.0, "demo": True})
            g["emps"].add(w["employee_id"]); g["n"] += 1; g["mins"] += w["minutes"] or 0
            g["tr"] += 1 if w["transfer_from_assignment_id"] else 0
            g["demo"] = g["demo"] and bool(w["is_demo"])
        return [{"work_date": k[0], "area_name": k[1], "area_kind": k[2], "distinct_mps": len(g["emps"]), "assignments": g["n"],
                 "transfers_in": g["tr"], "total_minutes": round(g["mins"], 1), "avg_minutes_per_assignment": round(g["mins"] / g["n"], 1),
                 "is_demo": g["demo"]} for k, g in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][3], kv[0][1]))]

    if name == "report_exceptions":
        rs = x.rows("""SELECT al.*, e.employee_code, e.full_name FROM alerts al LEFT JOIN employees e ON e.id = al.employee_id
            WHERE al.first_detected_at >= ? AND al.first_detected_at < ? ORDER BY al.first_detected_at""", (lo, hi))
        return [{"alert_id": a["id"], "alert_type": a["alert_type"], "severity": a["severity"], "status": a["status"],
                 "employee_code": a["employee_code"], "full_name": a["full_name"], "title": a["title"], "message": a["message"],
                 "first_detected_at": a["first_detected_at"], "acknowledged_at": a["acknowledged_at"], "resolved_at": a["resolved_at"],
                 "auto_resolved": bool(a["auto_resolved"]), "resolution_note": a["resolution_note"],
                 "open_minutes": _m(parse_ts(a["first_detected_at"]), parse_ts(a["resolved_at"]) or now)}
                for a in rs if a["employee_id"] is None or not x.has("supervisor") or can_view(x, a["employee_id"])]

    if name == "report_corrections":
        au = x.rows("""SELECT l.occurred_at, 'AUDIT' AS kind, l.action, u.full_name AS actor, l.actor_role, l.entity_type || ':' || coalesce(l.entity_id,'') AS entity,
            l.reason, l.before_data, l.after_data FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
            WHERE l.action NOT LIKE 'CONFIG_%' AND l.occurred_at >= ? AND l.occurred_at < ?""", (lo, hi))
        se = x.rows("""SELECT s.occurred_at, 'SECURITY' AS kind, s.action || ' ' || s.outcome AS action, u.full_name AS actor, s.role AS actor_role,
            NULL AS entity, NULL AS reason, s.details FROM security_events s LEFT JOIN users u ON u.id = s.user_id
            WHERE s.occurred_at >= ? AND s.occurred_at < ?""", (lo, hi))
        for r in au:
            r["details"] = json.dumps({"before": json.loads(r.pop("before_data") or "null"), "after": json.loads(r.pop("after_data") or "null")})
        return sorted(au + se, key=lambda r: r["occurred_at"])

    raise ValueError(f"Unknown report {name}")

