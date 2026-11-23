"""Built-in face kiosk: enrolment and matching.

The tablet finds the face and sends a small cropped picture. THIS SERVER (facengine.py: SCRFD + ArcFace, onnxruntime on the
CPU) turns it into a 512-number signature and matches it, so templates never leave the server.
A matched scan goes through the same gate rules as every other source
(duplicates, suspicious repeats, out-of-order, handover rules).
"""
from __future__ import annotations

import base64
import json
import math
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from . import assetdesk, config, earlyleave, facengine
from .db import dumps, iso, new_id, now_iso, parse_ts, utcnow
from .engine import (shift_for_entry, AppError, BadInput, Conflict, Ctx, NotFound, _hm, assign_work, audit, break_allowed, business_date,
                     auto_resolve, employee_by_scan, lunch_taken, mins, plan_pickup, process_gate_event, raise_alert, require, s_int, setting, shift_end_at, site_tz)

DIM = facengine.DIM
STAFF_ENROL = ("admin", "supervisor", "ld")          # ops_manager is view-only
SCANNERS = ("gate_operator", "admin", "ops_manager", "supervisor")
_SNAP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}/[0-9a-f-]{36}\.jpg$")


def photo_dir() -> Path:
    return config.DATA_DIR / "face_photos"


def snap_dir() -> Path:
    return config.DATA_DIR / "face_snaps"


# ---------------------------------------------------------------- template cache
# Revision counter lives in the database (same transaction as the change), so a cache
# can never keep stale templates after a commit, and a rolled-back change costs nothing.
_lock = threading.Lock()
_cache: dict[str, Any] = {"rev": None, "rows": []}


def _bump(x: Ctx) -> None:
    x.ex("INSERT INTO meta(key, value) VALUES ('face_rev', '1') "
         "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")


def _matrix(x: Ctx) -> tuple[np.ndarray, list[str]]:
    r = x.one("SELECT value FROM meta WHERE key='face_rev'")
    rev = r["value"] if r else "0"
    with _lock:
        if _cache["rev"] == rev:
            return _cache["rows"]
    owners, vecs = [], []
    for t in x.rows("SELECT t.employee_id, t.descriptor FROM face_templates t JOIN employees e ON e.id = t.employee_id WHERE e.is_active = 1"):
        v = json.loads(t["descriptor"])
        if len(v) == DIM:                       # templates of an older face engine (other length) are ignored
            owners.append(t["employee_id"]); vecs.append(v)
    out = (np.array(vecs, dtype=np.float32).reshape(-1, DIM), owners)
    with _lock:
        _cache.update(rev=rev, rows=out)
    return out


# ---------------------------------------------------------------- helpers
def _jpeg(data_url: Any, max_bytes: int = 400_000) -> bytes | None:
    if not data_url:
        return None
    if not isinstance(data_url, str):
        raise BadInput("Photo must be a data URL")
    b64 = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise BadInput("Photo is not valid base64")
    if len(raw) > max_bytes:
        raise BadInput("Photo too large")
    if not raw.startswith(b"\xff\xd8"):
        raise BadInput("Photo must be a JPEG")
    return raw


def best_matches(x: Ctx, q: np.ndarray) -> list[tuple[float, str]]:
    """Best similarity per employee, highest first (cosine similarity of two 512-number signatures)."""
    M, owners = _matrix(x)
    if not owners:
        return []
    best: dict[str, float] = {}
    for sim, emp in zip((M @ q).tolist(), owners):
        if sim > best.get(emp, -9.0):
            best[emp] = sim
    return sorted(((v, k) for k, v in best.items()), reverse=True)


def prepare(a: dict) -> None:
    """Run OUTSIDE the database transaction (it is the heavy part): the tablet's face picture -> signature in a['_emb']."""
    img = a.get("image")
    if not img:
        return
    try:
        arr = facengine.decode_image(_jpeg(img, 800_000))
        e, info = facengine.embed_image(arr, det_size=256, flip_fuse=False, norm=False)
    except facengine.EngineError as ex:
        raise BadInput(str(ex))
    a["_emb"] = e
    a["_faces"] = info.get("faces", 0)


def _augment(face: np.ndarray) -> list[np.ndarray]:
    """One clean photo -> the same face under other light / camera colour, so a darker, brighter or warmer scan still matches."""
    f = face.astype(np.float32)
    def mk(img): return np.clip(img, 0, 255).astype(np.uint8)
    return [face, mk(f * 0.6), mk(f * 1.4 + 15), mk(f * 1.7 + 30), mk(f * np.array([0.82, 1.0, 1.2])), mk(f * np.array([1.2, 1.0, 0.82]))]


# ---------------------------------------------------------------- enrolment
# Duplicate-face check at enrolment. The small face model (buffalo_s) can give two DIFFERENT people a
# similarity of 0.35-0.45 on tablet photos, so a new face is treated as a duplicate only from DUP_FLOOR
# upwards (setting face_dup_threshold can only raise it). A duplicate only rejects the NEW enrolment --
# the other person's enrolment is never touched.
DUP_FLOOR = 0.60


def enroll(x: Ctx, a: dict) -> dict:
    """Strict: every photo must be one clear, frontal, sharp, evenly lit face. Anything less is rejected (nothing is saved).
    A face that looks like someone else's enrolment is rejected (the other enrolment is left untouched)."""
    require(x.has(*STAFF_ENROL, "gate_operator", "ops_manager"), x, "face_enroll", employee=a.get("employee_id"))
    emp = x.one("SELECT id, employee_code, full_name FROM employees WHERE id=? AND is_active=1", (a.get("employee_id"),))
    if not emp:
        raise NotFound("Employee not found or inactive")
    if a.get("consent") is not True:
        raise BadInput("Record the MP's consent before enrolling their face")
    photos = a.get("photos")
    if not isinstance(photos, list) or not 1 <= len(photos) <= 5:
        raise BadInput("Send 1 to 5 photos")
    th = setting(x, "face_quality", None)
    th = th if isinstance(th, dict) else None
    bases, templates, first_img = [], [], None
    for i, p in enumerate(photos, 1):
        try:
            img = facengine.decode_image(_jpeg(p, 6_000_000) or b"")
            ok, why, face = facengine.quality(img, th)
            if not ok:
                raise BadInput(f"Photo {i} reject: {why}" if len(photos) > 1 else f"Photo reject: {why}")
            emb = facengine.embed_aligned(_augment(face), flip_fuse=True, norm=False)
        except facengine.EngineError as ex:
            raise BadInput(str(ex))
        bases.append(emb[0]); templates.extend(emb)
        first_img = first_img if first_img is not None else img
    for i in range(len(bases)):
        for j in range(i + 1, len(bases)):
            if float(bases[i] @ bases[j]) < 0.35:
                raise BadInput("Photos alag-alag logon ki lag rahi hain - sirf isi MP ki photos bhejiye")
    dup_thr = max(float(setting(x, "face_dup_threshold", DUP_FLOOR)), DUP_FLOOR)
    for b in bases:
        for sim, other in best_matches(x, b)[:1]:
            if other == emp["id"] or sim < dup_thr:
                continue
            o = x.one("SELECT employee_code, full_name FROM employees WHERE id=?", (other,))
            audit(x, "FACE_SIMILAR_REJECTED", "employees", emp["id"], None, {"other": o["employee_code"]},
                  {"employee": emp["employee_code"], "similarity": round(sim, 3)})
            msg = (f"Ye chehra {o['full_name']} ({o['employee_code']}) se milta-julta laga (similarity {sim:.2f}). "
                   f"{emp['employee_code']} enrol nahi hua; {o['employee_code']} ka face jaisa tha waisa hi hai. "
                   "Dono alag log hain to seedha, sahi roshni me, sirf ek chehra frame me rakh ke dobara photo lijiye.")
            return {"ok": False, "rejected": True, "code": "DUPLICATE_FACE", "message": msg,
                    "similarity": round(sim, 3), "other": {"code": o["employee_code"], "name": o["full_name"]}}
    before = x.one("SELECT COUNT(*) AS n FROM face_templates WHERE employee_id=?", (emp["id"],))["n"]
    x.ex("DELETE FROM face_templates WHERE employee_id=?", (emp["id"],))
    for v in templates:
        x.ex("INSERT INTO face_templates(id, employee_id, descriptor, created_by, created_at) VALUES (?,?,?,?,?)",
             (new_id(), emp["id"], json.dumps([round(float(n), 6) for n in v]), x.uid, now_iso()))
    if first_img is not None:
        import cv2
        h, w = first_img.shape[:2]; sc = 360 / max(h, w) if max(h, w) > 360 else 1.0
        ok_, buf = cv2.imencode(".jpg", cv2.resize(first_img, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 85])
        if ok_:
            photo_dir().mkdir(parents=True, exist_ok=True)
            (photo_dir() / f"{emp['id']}.jpg").write_bytes(buf.tobytes())
    audit(x, "FACE_ENROLLED", "employees", emp["id"], None, {"samples": before}, {"samples": len(templates), "photos": len(photos), "consent": True})
    _bump(x)
    return {"ok": True, "employee_id": emp["id"], "samples": len(templates)}


def find_employees(x: Ctx, q: str) -> list[dict]:
    """Gate / supervisor: search an employee by code, name or badge (for face enrolment)."""
    require(x.has(*STAFF_ENROL, "gate_operator", "ops_manager"), x, "find_employees")
    q = (q or "").strip()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    rows = x.rows("""SELECT e.id, e.employee_code, e.full_name, e.designation, e.badge_code,
                       (SELECT COUNT(*) FROM face_templates t WHERE t.employee_id = e.id) AS samples
                     FROM employees e WHERE e.is_active = 1
                       AND (e.employee_code LIKE ? OR e.full_name LIKE ? OR coalesce(e.badge_code, '') LIKE ?)
                     ORDER BY (e.employee_code = ? COLLATE NOCASE OR e.badge_code = ?) DESC, e.full_name LIMIT 20""",
                  (like, like, like, q, q))
    for r in rows:
        r["has_photo"] = (photo_dir() / f"{r['id']}.jpg").exists()
    return rows


def add_employee(x: Ctx, a: dict) -> dict:
    """Gate operator adds a new MP (code + name) so the face can be enrolled at once. Admin edits the rest later."""
    require(x.has("admin", "gate_operator", "supervisor", "ops_manager", "ld"), x, "gate_add_employee")
    code = re.sub(r"\s+", "", str(a.get("employee_code") or "")).upper()
    name = re.sub(r"\s+", " ", str(a.get("full_name") or "")).strip()
    if not re.fullmatch(r"[A-Z0-9_-]{2,30}", code):
        raise BadInput("Employee ID: 2-30 letters / numbers")
    if len(name) < 2:
        raise BadInput("Naam likhiye")
    if x.one("SELECT 1 FROM employees WHERE employee_code = ? COLLATE NOCASE", (code,)):
        raise Conflict(f"Employee {code} pehle se hai — search karke wahi chuniye")
    badge = re.sub(r"\s+", "", str(a.get("badge_code") or "")) or (re.search(r"(\d+)$", code).group(1) if re.search(r"(\d+)$", code) else None)
    if badge and x.one("SELECT 1 FROM employees WHERE badge_code = ?", (badge,)):
        badge = None
    eid, t = new_id(), now_iso()
    x.ex("INSERT INTO employees(id, employee_code, full_name, designation, badge_code, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
         (eid, code, name, (str(a.get("designation") or "").strip() or None), badge, t, t))
    audit(x, "EMPLOYEE_ADDED_AT_GATE", "employees", eid, None, None, {"employee_code": code, "full_name": name})
    return {"ok": True, "id": eid, "employee_code": code, "full_name": name, "badge_code": badge}


def unenroll(x: Ctx, emp_id: str) -> dict:
    require(x.has("admin"), x, "face_unenroll", employee=emp_id)
    n = x.ex("DELETE FROM face_templates WHERE employee_id=?", (emp_id,)).rowcount
    if not n:
        raise NotFound("No face enrolment for this employee")
    (photo_dir() / f"{emp_id}.jpg").unlink(missing_ok=True)
    audit(x, "FACE_UNENROLLED", "employees", emp_id, None, {"samples": n}, None)
    _bump(x)
    return {"ok": True}


def enrollments(x: Ctx) -> list[dict]:
    require(x.has(*STAFF_ENROL), x, "face_enrollments")
    rows = x.rows("""SELECT e.id, e.employee_code, e.full_name, e.designation, e.is_demo,
                       COUNT(t.id) AS samples, MAX(t.created_at) AS enrolled_at, u.full_name AS enrolled_by
                     FROM employees e LEFT JOIN face_templates t ON t.employee_id = e.id
                     LEFT JOIN users u ON u.id = (SELECT created_by FROM face_templates WHERE employee_id = e.id LIMIT 1)
                     WHERE e.is_active = 1 GROUP BY e.id ORDER BY e.employee_code""")
    for r in rows:
        r["has_photo"] = (photo_dir() / f"{r['id']}.jpg").exists()
    return rows


# ---------------------------------------------------------------- scanning
def _match(x: Ctx, a: dict) -> tuple[str | None, str | None, dict]:
    """(employee_id or None, reason if not matched, match info)."""
    q = a.get("_emb")
    if q is None:
        if a.get("image"):
            return None, "Chehra picture me nahi mila", {"distance": None, "second": None}
        raise BadInput("Face picture missing")
    thr = float(setting(x, "face_sim_threshold", 0.40))
    margin = float(setting(x, "face_sim_margin", 0.05))
    ranked = best_matches(x, q)
    best = ranked[0] if ranked else None
    second = ranked[1][0] if len(ranked) > 1 else None
    info = {"distance": round(1 - best[0], 4) if best else None, "second": round(1 - second, 4) if second is not None else None,
            "similarity": round(best[0], 4) if best else None}
    if not best or best[0] < thr:
        return None, "Face not recognised" + (f" (closest similarity {best[0]:.2f})" if best else " (no faces enrolled)"), info
    if second is not None and best[0] - second < margin:
        return None, f"Ambiguous match (similarity {best[0]:.2f} / {second:.2f}) - please scan again", info
    return best[1], None, info


def _save_snapshot(x: Ctx, data_url: Any) -> str | None:
    if not setting(x, "face_save_snapshots", True):
        return None
    img = _jpeg(data_url, 200_000)
    if not img:
        return None
    day = utcnow().strftime("%Y-%m-%d")
    (snap_dir() / day).mkdir(parents=True, exist_ok=True)
    name = f"{day}/{new_id()}.jpg"
    (snap_dir() / name).write_bytes(img)
    return name


def _employee(x: Ctx, emp: str | None) -> dict | None:
    if not emp:
        return None
    e = x.one("SELECT id, employee_code AS code, full_name AS name FROM employees WHERE id=?", (emp,))
    if e:
        e["has_photo"] = (photo_dir() / f"{e['id']}.jpg").exists()
    return e


def result(label: str, sub: str = "", tone: str = "green", alarm: bool = False) -> dict:
    """What the kiosk shows full-screen. tone: green (IN ok) / blue (OUT ok) / red (late, rejected, unknown)."""
    return {"label": label, "sub": sub, "tone": tone, "alarm": alarm}


def _hm_text(minutes: float) -> str:
    m = int(minutes)
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m} min"


# ---------------------------------------------------------------- gate kiosk: DC IN / DC OUT rules
def _shift_start(x: Ctx, shift_id: str | None, t: datetime) -> datetime | None:
    if not shift_id:
        return None
    sh = x.one("SELECT * FROM shifts WHERE id=?", (shift_id,))
    if not sh:
        return None
    d = business_date(x, shift_id, t)
    return datetime.combine(d, _hm(sh["start_time"]), tzinfo=site_tz(x))


def _plan_in(x: Ctx, s: dict, emp: str, t: datetime) -> dict:
    """Result for a DC IN, decided before the gate event is applied."""
    if s["status"] in ("NOT_CHECKED_IN", "SHIFT_ENDED") or not s["attendance_id"]:
        shift_id = shift_for_entry(x, t) or (x.one("SELECT default_shift_id FROM employees WHERE id=?", (emp,)) or {}).get("default_shift_id")
        start = _shift_start(x, shift_id, t)
        if start:
            late = (t - start).total_seconds() / 60
            if late > s_int(x, "dc_late_grace_minutes", 15):
                return result("DC IN LATE", f"{_hm_text(late)} late · shift {start.strftime('%H:%M')}", "green", False)   # late shift IN is still a successful scan (green, no alarm); it shows in the attendance report
            return result("DC IN", f"SHIFT START · {start.strftime('%H:%M')}")
        return result("DC IN", "SHIFT START")
    if s["status"] == "OUTSIDE_BREAK" and s["break_id"]:
        b = x.one("SELECT break_type, started_at FROM break_records WHERE id=?", (s["break_id"],))
        if b and b["break_type"] == "LUNCH":
            took = (t - parse_ts(b["started_at"])).total_seconds() / 60
            _, before = lunch_taken(x, emp, s["attendance_id"], t, exclude=s["break_id"])   # earlier lunch parts this shift
            total = before + took
            limit = break_allowed(x, "LUNCH")
            extra = f" · total {_hm_text(total)}" if before > 0 else ""
            if total > limit:
                return result("DC IN LATE", f"Lunch {_hm_text(took)}{extra} (limit {limit} min)", "green", False)   # lunch overrun is still a successful scan
            return result("DC IN", f"LUNCH RETURN · {_hm_text(took)}{extra}")
        return result("DC IN", "BREAK RETURN")
    if s["status"] in ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL"):
        return result("DC IN", "PICKUP RETURN")
    return result("DC IN")


# ---------------------------------------------------------------- supervisors who have a login (username = employee code)
def my_employee(x: Ctx) -> str | None:
    """Employee record of the logged-in supervisor: the linked employee, else the employee whose code equals the username."""
    u = x.one("SELECT username, employee_id FROM users WHERE id=?", (x.uid,)) if x.uid else None
    if not u:
        return None
    if u["employee_id"]:
        return u["employee_id"]
    r = x.one("SELECT id FROM employees WHERE is_active=1 AND upper(employee_code)=upper(?)", (u["username"],))
    return r["id"] if r else None


def is_sup_emp(x: Ctx, emp: str) -> bool:
    """True when this employee has a supervisor login: no IN/OUT restrictions for them."""
    return bool(x.one("""SELECT 1 FROM users u JOIN employees e ON e.id=?
                         WHERE u.role='supervisor' AND u.is_active=1
                           AND (u.employee_id=e.id OR upper(u.username)=upper(e.employee_code)) LIMIT 1""", (emp,)))


def _sup_out(x: Ctx, s: dict, emp: str, t: datetime) -> tuple[str, dict]:
    """Supervisor-ID employee: every OUT is OFFICIAL WORK except the last one of the shift (shift end), no checks."""
    att = x.one("SELECT checked_in_at FROM shift_attendance WHERE id=?", (s["attendance_id"],)) if s["attendance_id"] else None
    worked = (t - parse_ts(att["checked_in_at"])).total_seconds() / 60 if att and att["checked_in_at"] else 0
    need = float(setting(x, "dc_min_shift_hours", 9)) * 60
    end = shift_end_at(x, s["attendance_id"])
    if worked >= need or (end and t >= end - mins(s_int(x, "shift_end_window_minutes", 45))):
        return "SHIFT_END", result("DC OUT", f"SHIFT END · {_hm_text(worked)}", "blue")
    return "OFFICIAL", result("DC OUT", "OFFICIAL WORK", "blue")


def my_areas(x: Ctx) -> dict:
    """Areas the admin ticked for this supervisor (empty = none ticked = all areas)."""
    return {"area_ids": [r["area_id"] for r in x.rows("SELECT area_id FROM supervisor_areas WHERE user_id=?", (x.uid,))]}


def self_deploy(x: Ctx, a: dict) -> dict:
    """A supervisor who chose his work area is deployed there himself (auto DC IN first if he is not inside)."""
    require(x.has("admin", "supervisor"), x, "self_deploy", area=a.get("area_id"))
    emp = my_employee(x)
    area = x.one("SELECT id, code, name, out_purpose FROM areas WHERE id=? AND is_active=1", (a.get("area_id"),))
    if not emp:
        return {"ok": True, "deployed": False, "reason": "Aapka employee record nahi mila — username = employee code rakhiye (ya Admin me Linked employee set karwaiye)"}
    if not area or area["out_purpose"]:
        return {"ok": True, "deployed": False}
    now = utcnow()
    s = x.one("SELECT status, presence, assignment_id FROM mp_current_state WHERE employee_id=?", (emp,))
    if not s:
        return {"ok": True, "deployed": False}
    if s["presence"] != "INSIDE":
        process_gate_event(x, emp, "IN", now, "FACE_DEVICE", device_id=None, device_event_id=None, person_ref=None,
                           reason="DC IN · supervisor login", raw={"auto_in": True, "operator": x.uid, "result": result("DC IN")})
        s = x.one("SELECT status, presence, assignment_id FROM mp_current_state WHERE employee_id=?", (emp,))
    if s["presence"] != "INSIDE" or s["status"] not in ("INSIDE_UNASSIGNED", "WORKING"):
        return {"ok": True, "deployed": False, "status": s["status"], "reason": f"Deploy nahi hua — aapka status {s['status']} hai"}
    pend = pending_out(x, emp, now)
    if pend:   # assigned for pickup / lunch: he cannot be deployed anywhere else until that is cancelled or used
        return {"ok": True, "deployed": False, "reason": f"Aap {pend['out_name']} ke liye assign ho — abhi deploy nahi ho sakte"}
    cur = x.one("SELECT area_id FROM work_assignments WHERE id=?", (s["assignment_id"],)) if s["assignment_id"] else None
    if s["status"] == "WORKING" and cur and cur["area_id"] == area["id"]:
        return {"ok": True, "deployed": True, "already": True}
    try:
        assign_work(x, {"p_employee_id": emp, "p_area_id": area["id"], "p_task": None, "p_supervisor_user_id": x.uid,
                        "p_reason": "Supervisor self deploy"})
    except AppError as err:
        return {"ok": True, "deployed": False, "reason": f"Deploy nahi hua — {err.message}"}
    return {"ok": True, "deployed": True}


def _held(x: Ctx, emp: str) -> dict | None:
    """Devices (Asset Desk) issued on this MP's name right now; None = unknown / check switched off."""
    if not setting(x, "asset_check_enabled", True):
        return None
    r = x.one("SELECT employee_code FROM employees WHERE id=?", (emp,))
    return assetdesk.holdings(r["employee_code"], str(setting(x, "assetdesk_url", "http://127.0.0.1:8060"))) if r else None


def _ids(h: dict, area: str | None = None) -> str:
    ids = [a["asset_id"] for a in h["assets"] if area is None or a.get("issue_area") == area]
    return " · " + ", ".join(ids[:4]) + (f" +{len(ids) - 4}" if len(ids) > 4 else "") if ids else ""


def _plan_out(x: Ctx, s: dict, emp: str, t: datetime) -> tuple[str | None, dict, str | None]:
    """(purpose, result, lunch permit id). Only an OUT assigned by a supervisor (pickup / lunch / other) lets the MP out;
    without one, OUT is allowed only as shift end after the minimum shift hours. purpose None = OUT not allowed."""
    p = x.one("SELECT purpose FROM pickup_assignments WHERE employee_id=? AND status='PLANNED'", (emp,))
    if p:
        if p["purpose"] == "PICKUP":   # a pickup MP may not take a FLOOR device out of the DC
            h = _held(x, emp)
            if h and h["floor"] > 0:
                return None, result("DC OUT REJECTED", "Return Floor Device First" + _ids(h, "Floor"), "red", True), None
        return p["purpose"], result("DC OUT", {"PICKUP": "PICKUP", "OFFICIAL": "OFFICIAL WORK"}.get(p["purpose"], "OTHER"), "blue"), None
    permit = x.one("SELECT id FROM exit_permits WHERE employee_id=? AND status='PENDING' AND valid_until >= ? "
                   "ORDER BY created_at DESC LIMIT 1", (emp, iso(t)))
    if permit:
        return "LUNCH", result("DC OUT", "LUNCH", "blue"), permit["id"]
    el = earlyleave.approved_for(x, emp, t)
    if el:   # supervisor raised an early-leave request and Ops Manager / Admin approved it
        h = _held(x, emp)
        if h and h["total"] > 0:
            return None, result("DC OUT REJECTED", "Return Device First" + _ids(h), "red", True), None
        return "SHIFT_END", result("DC OUT", "EARLY LEAVE · approved", "blue"), "EL:" + el
    att = x.one("SELECT checked_in_at FROM shift_attendance WHERE id=?", (s["attendance_id"],)) if s["attendance_id"] else None
    since = att["checked_in_at"] if att else None
    worked = (t - parse_ts(since)).total_seconds() / 60 if since else 0
    need = float(setting(x, "dc_min_shift_hours", 9)) * 60
    if worked >= need:
        h = _held(x, emp)   # going home: nothing (floor or pickup device) may still be issued on his name
        if h and h["total"] > 0:
            return None, result("DC OUT REJECTED", "Return Device First" + _ids(h), "red", True), None
        return "SHIFT_END", result("DC OUT", f"SHIFT END · {_hm_text(worked)}", "blue"), None
    return None, result("DC OUT REJECTED", f"OUT assign nahi hai · shift {_hm_text(worked)} (min {_hm_text(need)})", "red", True), None


def _recent_gate_result(x: Ctx, emp: str, t: datetime, device_id: str | None = None, s: dict | None = None) -> dict | None:
    """Same person scanned again at the SAME gate within a couple of minutes -> same answer. Not when the MP was scanned
    at another gate / deployed / handed over in between (his state changed after that gate event)."""
    win = s_int(x, "dc_repeat_seconds", 120)
    r = x.one("""SELECT raw_payload, event_time FROM gate_events WHERE employee_id=? AND source='FACE_DEVICE' AND device_id IS ?
                 AND processing_status IN ('APPLIED','REJECTED') AND event_time BETWEEN ? AND ?
                 ORDER BY event_time DESC LIMIT 1""",
              (emp, device_id, iso(t - timedelta(seconds=win)), iso(t + timedelta(seconds=win))))
    if r and s and s.get("status_since") and parse_ts(s["status_since"]) > parse_ts(r["event_time"]) + timedelta(seconds=2):
        return None
    try:
        res = json.loads(r["raw_payload"]).get("result") if r and r["raw_payload"] else None
    except (TypeError, ValueError):
        res = None
    return res


def wrong_gate(mode: str | None, presence: str | None, user_dirs: set | None = None) -> dict | None:
    """Separate IN and OUT gates. Direction still comes from the MP's state (INSIDE -> OUT, otherwise IN).
    - user_dirs: the gate-operator login's own access ({'IN'}, {'OUT'}; None / both = no limit)
    - mode: the device, set to "entry only" (in_only) or "exit only" (out_only)
    Returns the red result to show, or None if this scan is allowed."""
    going_out = presence == "INSIDE"
    want = "OUT" if going_out else "IN"
    if user_dirs and want not in user_dirs:
        if going_out:
            return result("USE OUT GATE", "Aapka login sirf DC IN ke liye hai - OUT wale gate operator se scan kariye", "red", True)
        return result("USE IN GATE", "Aapka login sirf DC OUT ke liye hai - pehle IN wale gate par scan kariye", "red", True)
    if mode == "in_only" and going_out:
        return result("USE OUT GATE", "Ye sirf DC IN gate hai - OUT ke liye OUT gate par scan kariye", "red", True)
    if mode == "out_only" and not going_out:
        return result("USE IN GATE", "Ye sirf DC OUT gate hai - pehle IN gate par scan kariye", "red", True)
    return None


def _user_gates(x: Ctx) -> set | None:
    """Gate-operator logins only: the directions ticked for this user in Admin -> Users. None = no limit."""
    if getattr(x, "role", None) != "gate_operator" or not getattr(x, "uid", None):
        return None
    got = {r["direction"] for r in x.rows("SELECT direction FROM gate_access WHERE user_id=?", (x.uid,))}
    return got if got and got != {"IN", "OUT"} else None


def scan(x: Ctx, a: dict) -> dict:
    """Gate face kiosk. Direction is decided by the server from the MP's state (no IN/OUT buttons)."""
    require(x.has("gate_operator", "admin", "supervisor"), x, "face_scan", device=a.get("device_code"))   # ops_manager: view only
    dev = x.one("SELECT * FROM devices WHERE device_code=? AND is_active=1", (a.get("device_code"),))
    if not dev:
        raise NotFound(f"Device {a.get('device_code')} not registered or disabled")
    eid = a.get("client_event_id")
    if eid:   # offline re-send of a scan we already processed -> same answer
        old = x.one("SELECT raw_payload, employee_id, direction, processing_status FROM gate_events WHERE device_id=? AND device_event_id=?",
                    (dev["id"], eid))
        if old:
            res = (json.loads(old["raw_payload"] or "{}") or {}).get("result")
            e = _employee(x, old["employee_id"])
            return {"ok": True, "applied": False, "processing_status": "DUPLICATE_SUBMISSION", "employee": e,
                    "matched": e is not None, "direction": old["direction"], "result": res, "repeat": True}

    emp, reason, info = _match(x, a)
    t = parse_ts(a.get("captured_at")) or utcnow()
    e = _employee(x, emp)

    sup = bool(emp) and is_sup_emp(x, emp)      # supervisor-ID employee: unlimited IN / OUT, no rules
    if emp and not sup:
        prev = _recent_gate_result(x, emp, t, dev["id"], x.one("SELECT status_since FROM mp_current_state WHERE employee_id=?", (emp,)))
        if prev:   # scanned again by mistake -> show the same result, record nothing
            return {"ok": True, "applied": False, "processing_status": "REPEAT", "employee": e, "matched": True,
                    "direction": "OUT" if prev["label"].startswith("DC OUT") else "IN", "result": prev, "repeat": True}

    snap = _save_snapshot(x, a.get("snapshot"))
    raw = {**info, "snapshot": snap, "operator": x.uid}

    if not emp:
        res = result("PEHCHAAN NAHI HUI", "Supervisor se face enrol karwaiye", "red", True)
        r = process_gate_event(x, None, "IN", t, "FACE_DEVICE", device_id=dev["id"], device_event_id=eid,
                               person_ref="UNKNOWN_FACE", reason=reason, raw={**raw, "result": res})
        return {**r, "employee": None, "matched": False, "reason": reason, "direction": "IN", "result": res}

    s = x.one("SELECT * FROM mp_current_state WHERE employee_id=?", (emp,))
    conf = round(max(0.0, 1 - (info["distance"] or 1)), 3)
    wg = wrong_gate(dev["direction_mode"], s["presence"], _user_gates(x))
    if wg:   # scanned at the wrong gate (IN-only / OUT-only device): nothing is recorded, the MP's state stays as it is
        return {"ok": True, "applied": False, "processing_status": "WRONG_GATE", "employee": e, "matched": True,
                "direction": "OUT" if s["presence"] == "INSIDE" else "IN", "result": wg}
    if s["presence"] == "INSIDE":
        direction = "OUT"
        if sup:   # supervisor-ID employee: free in/out unless a device is still issued on his name (even for official work)
            h = _held(x, emp)
            if h and h["total"] > 0:
                purpose, res, permit = None, result("DC OUT REJECTED", "Return Device First" + _ids(h), "red", True), None
            else:
                (purpose, res), permit = _sup_out(x, s, emp, t), None
        else:
            purpose, res, permit = _plan_out(x, s, emp, t)
        if purpose is None:   # not allowed out: logged for review, state untouched
            gid = new_id()
            x.ex("""INSERT INTO gate_events(id, employee_id, device_id, device_event_id, person_ref, direction, event_time, received_at,
                    source, match_confidence, processing_status, processing_note, actor_user_id, reason, raw_payload)
                    VALUES (?,?,?,?,?, 'OUT', ?,?, 'FACE_DEVICE', ?, 'REJECTED', ?,?,?,?)""",
                 (gid, emp, dev["id"], eid, e["code"], iso(t), now_iso(), conf, "OUT not allowed: " + res["sub"], x.uid,
                  f"{res['label']} · {res['sub']}", dumps({**raw, "result": res})))
            raise_alert(x, "GATE_OUT_REJECTED", "WARNING", emp, "gate_event", gid, f"GATE_OUT_REJECTED:{gid}",
                        "DC OUT rejected at gate", f"{e['name']}: {res['sub']}")
            return {"ok": True, "applied": False, "processing_status": "REJECTED", "gate_event_id": gid, "employee": e,
                    "matched": True, "direction": "OUT", "result": res}
    else:
        direction, purpose, permit = "IN", None, None
        res = result("DC IN") if sup else _plan_in(x, s, emp, t)

    if direction == "IN" and s["pickup_id"]:   # back from pickup / official: straight to "unassigned" - no handover, no auto area
        x.ex("UPDATE pickup_assignments SET handover_required=0, next_area_id=NULL WHERE id=?", (s["pickup_id"],))
    r = process_gate_event(x, emp, direction, t, "FACE_DEVICE", device_id=dev["id"], device_event_id=eid, purpose=purpose,
                           confidence=conf, person_ref=e["code"], reason=f"{res['label']} · {res['sub']}".strip(" ·"),
                           raw={**raw, "result": res})
    if r.get("processing_status") not in ("APPLIED", "DUPLICATE_SUBMISSION"):
        # e.g. an old offline scan arriving after a newer one (OUT_OF_ORDER) -> flagged for review
        res = result(f"DC {direction}", f"{r.get('processing_status')}: {r.get('note') or ''}".strip(": "), "red", True)
    elif permit and permit.startswith("EL:") and r.get("processing_status") == "APPLIED":
        earlyleave.mark_used(x, permit[3:], t, r.get("gate_event_id"))
    elif permit and r.get("processing_status") == "APPLIED":
        x.ex("UPDATE exit_permits SET status='USED', used_at=?, gate_event_id=? WHERE id=?", (iso(t), r["gate_event_id"], permit))
    if sup and direction == "OUT" and purpose == "OFFICIAL" and r.get("processing_status") == "APPLIED":
        far = iso(t + timedelta(hours=16))      # official work: no "late back" alerts for supervisor-ID employees
        x.ex("UPDATE pickup_assignments SET expected_return_at=? WHERE departure_gate_event_id=?", (far, r["gate_event_id"]))
        x.ex("UPDATE mp_current_state SET expected_by=? WHERE employee_id=?", (far, emp))
    if r.get("processing_status") == "APPLIED":
        # pickup has no fixed return time: no deadline, so no "late return" / PICKUP_DELAYED alert (lunch keeps its own limit)
        x.ex("UPDATE pickup_assignments SET expected_return_at=NULL WHERE status='OUT' AND expected_return_at IS NOT NULL")
        x.ex("UPDATE mp_current_state SET expected_by=NULL WHERE status IN ('OUTSIDE_PICKUP','OUTSIDE_OFFICIAL','OUTSIDE_OTHER') AND expected_by IS NOT NULL")
    if r.get("processing_status") == "APPLIED":   # MP went in/out: earlier supervisor repeat answers no longer apply
        with _deploy_lock:
            for k in [k for k in _deploy_recent if k[0] == emp]:
                _deploy_recent.pop(k, None)
    return {**r, "employee": e, "matched": True, "direction": direction, "result": res}


def identify(x: Ctx, a: dict) -> dict:
    """Who is this face? (Asset Desk) - looks the person up only; no gate IN/OUT, nothing is recorded."""
    emp, reason, info = _match(x, a)
    e = _employee(x, emp)
    if not e:
        return {"ok": True, "matched": False, "reason": reason, "distance": info.get("distance")}
    row = x.one("SELECT designation FROM employees WHERE id=?", (emp,)) or {}
    return {"ok": True, "matched": True, "employee": {"emp_id": e["code"], "name": e["name"], "designation": row.get("designation"),
                                                       "has_photo": e["has_photo"], "id": e["id"]}, "distance": info.get("distance")}


# ---------------------------------------------------------------- supervisor kiosk: deployment only
_deploy_lock = threading.Lock()
_deploy_recent: dict[tuple[str, str], tuple[datetime, dict]] = {}


def _identify(x: Ctx, a: dict) -> tuple[str | None, str | None, dict, str]:
    """MP from an ID card / QR / typed code (scan_value) or a face (descriptor)."""
    if a.get("scan_value") is not None:
        v = str(a.get("scan_value") or "").strip()
        emp = employee_by_scan(x, v) if v else None
        return emp, (None if emp else f"'{v}' kisi active employee ka ID nahi hai"), {}, "EMPLOYEE NAHI MILA"
    emp, reason, info = _match(x, a)
    return emp, reason, info, "PEHCHAAN NAHI HUI"


def deploy(x: Ctx, a: dict) -> dict:
    """Supervisor scans an MP's ID card / QR (scan_value) or face (descriptor) -> deployed to the chosen area. No IN/OUT here."""
    require(x.has("admin", "supervisor"), x, "face_deploy", area=a.get("area_id"))
    area = x.one("SELECT id, code, name, out_purpose FROM areas WHERE id=? AND is_active=1", (a.get("area_id"),))
    if not area:
        raise NotFound("Choose an active area first")
    if area["out_purpose"] == "PICKUP":   # deploying into the Pickup area = pickup assigned (gate OUT then shows "On Pickup")
        return assign_out(x, {k: v for k, v in a.items() if k != "area_id"} | {"out_area_id": area["id"], "handover_required": False, "_deploy_area": area["id"]})
    if area["out_purpose"]:
        raise BadInput(f"{area['name']} OUT option hai, work area nahi — OUT assign se bhejiye")
    emp, reason, info, not_found = _identify(x, a)
    e = _employee(x, emp)
    if not emp:
        return {"ok": True, "matched": False, "reason": reason, "employee": None,
                "result": result(not_found, reason or "", "red", True)}
    now = utcnow()
    key = (emp, area["id"])
    win = s_int(x, "dc_repeat_seconds", 120)
    ver = (x.one("SELECT version FROM mp_current_state WHERE employee_id=?", (emp,)) or {}).get("version")
    with _deploy_lock:
        prev = _deploy_recent.get(key)
        if prev and (now - prev[0]).total_seconds() < win and prev[2] == ver:   # same answer only while nothing changed
            return {"ok": True, "matched": True, "employee": e, "result": prev[1], "repeat": True}

    s = x.one("SELECT status, presence, assignment_id FROM mp_current_state WHERE employee_id=?", (emp,))
    label_area = f"{area['name']} ({area['code']})"
    away = s["status"] in ("OUTSIDE_PICKUP", "OUTSIDE_OFFICIAL", "OUTSIDE_OTHER", "OUTSIDE_BREAK")   # out on pickup / official / lunch
    if s["presence"] != "INSIDE" and not away:
        # Gate pe IN nahi hua tha: supervisor ke deploy se hi DC IN ho jata hai (late/on-time rule same), phir deploy
        try:
            in_res = _plan_in(x, s, emp, now)
            r_in = process_gate_event(x, emp, "IN", now, "FACE_DEVICE", device_id=None, device_event_id=None,
                                      person_ref=e["code"], reason=f"AUTO IN via deploy · {in_res['label']} · {in_res['sub']}".strip(" ·"),
                                      raw={"auto_in": True, "operator": x.uid, "result": in_res})
            if r_in.get("processing_status") == "APPLIED":
                s = x.one("SELECT status, presence, assignment_id FROM mp_current_state WHERE employee_id=?", (emp,))
        except AppError:
            pass
    if away:   # on pickup / official work / lunch outside: nobody can deploy him until he is back through the gate
        what = {"OUTSIDE_PICKUP": "PICKUP", "OUTSIDE_OFFICIAL": "OFFICIAL WORK", "OUTSIDE_OTHER": "OUT", "OUTSIDE_BREAK": "LUNCH"}[s["status"]]
        res = result(f"{what} PAR HAI", "MP abhi DC ke bahar hai — gate se wapas aane ke baad hi deploy hoga", "red", True)
    elif s["presence"] != "INSIDE":
        res = result("DC IN NAHI HUA", "Pehle gate pe DC IN karwaiye", "red", True)
    else:
        cur = x.one("SELECT area_id FROM work_assignments WHERE id=?", (s["assignment_id"],)) if s["assignment_id"] else None
        other = None
        if s["status"] == "WORKING" and cur and cur["area_id"] != area["id"]:
            other = x.one("SELECT name FROM areas WHERE id=?", (cur["area_id"],))["name"]
        incoming = x.one("SELECT 1 FROM area_transfers WHERE employee_id=? AND to_area_id=? AND status='PENDING'", (emp, area["id"]))
        pend = pending_out(x, emp, now)
        sender = pend and pend["from_area_id"]   # only the area that really sent him; the area he happens to work in does not count
        taken_back = False
        if pend and (not sender or sender != area["id"]):   # assigned for pickup / lunch: no other area can deploy him
            nm = (x.one("SELECT name FROM areas WHERE id=?", (sender,)) or {}).get("name") if sender else None
            res = result(f"ASSIGNED FOR {pend['out_name']}",
                         f"{nm} ne bheja hai — sirf {nm} wapas le sakta hai" if nm else "Pehle se OUT assign hai — wo cancel hone ke baad hi deploy hoga", "red", True)
        elif pend:   # the sending area scans him again -> OUT cancelled, MP stays / goes back to work here
            cancel_out(x, pend, f"Taken back by {area['name']}")
            taken_back = True
        if pend and not taken_back:
            pass                    # refused above
        elif other:   # no MP moves between areas without handover + takeover
            res = result("HANDOVER CHAHIYE", f"MP abhi {other} mein hai" + (" — notification mein Receive kariye" if incoming
                                                                            else f" — {other} ke supervisor se handover lijiye"), "red", True)
        elif s["status"] == "WORKING" and cur and cur["area_id"] == area["id"] and not (a.get("task") or None):
            res = result("DEPLOYED", f"{label_area} · {pend['out_name']} cancel") if taken_back else result("ALREADY DEPLOYED", label_area)
        else:
            try:
                assign_work(x, {"p_employee_id": emp, "p_area_id": area["id"], "p_task": a.get("task") or None,
                                "p_supervisor_user_id": x.uid, "p_reason": "Face deployment"})
                res = result("DEPLOYED", label_area + (f" · {pend['out_name']} cancel" if taken_back else ""))
            except AppError as err:
                msg = {"ON_BREAK": "Break pe hai", "HANDOVER_PENDING": "Handover pending hai",
                       "HANDOVER_IN_PROGRESS": "Handover chal raha hai"}.get(s["status"], err.message)
                res = result("DEPLOY NAHI HUA", msg, "red", True)
    with _deploy_lock:
        if not res["alarm"]:          # only successes repeat; a refusal is re-checked (e.g. MP has just done DC IN)
            for k in [k for k in _deploy_recent if k[0] == emp]:   # a new action replaces the MP's older repeat answers
                _deploy_recent.pop(k, None)
            _deploy_recent[key] = (now, res, (x.one("SELECT version FROM mp_current_state WHERE employee_id=?", (emp,)) or {}).get("version"))
        for k in [k for k, v in _deploy_recent.items() if (now - v[0]).total_seconds() > win]:
            _deploy_recent.pop(k, None)
    return {"ok": True, "matched": True, "employee": e, "result": res, "match": info}


def config_for_kiosk(x: Ctx) -> dict:
    return {"require_blink": bool(setting(x, "face_require_blink", False)),
            "enrolled": x.one("SELECT COUNT(DISTINCT employee_id) AS n FROM face_templates")["n"]}


def snapshot_path(name: str) -> Path | None:
    if not _SNAP_RE.match(name or ""):
        return None
    p = snap_dir() / name
    return p if p.exists() else None


def cleanup_snapshots(keep_days: int) -> int:
    root = snap_dir()
    if not root.exists():
        return 0
    cutoff = (utcnow() - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    n = 0
    for day in root.iterdir():
        if day.is_dir() and day.name < cutoff:
            for f in day.glob("*.jpg"):
                f.unlink(missing_ok=True)
                n += 1
            try:
                day.rmdir()
            except OSError:
                pass
    return n


def lunch_left(x: Ctx, emp: str, s: dict, now: datetime) -> tuple[float, str]:
    """(minutes of lunch left this shift, "13:20-13:55, 14:30-14:35")."""
    parts, used = lunch_taken(x, emp, s.get("attendance_id"), now)
    tz = site_tz(x)
    text = ", ".join(f"{a.astimezone(tz):%H:%M}-{b.astimezone(tz):%H:%M}" for a, b in parts)
    return break_allowed(x, "LUNCH") - used, text


def pending_out(x: Ctx, emp: str, now: datetime) -> dict | None:
    """OUT given by a supervisor that the MP has not used yet (lunch permit / planned pickup or other)."""
    p = x.one("SELECT id, out_area_id, from_area_id, created_by AS by_user, 'permit' AS kind, 'LUNCH' AS purpose FROM exit_permits "
              "WHERE employee_id=? AND status='PENDING' AND valid_until >= ? ORDER BY created_at DESC LIMIT 1", (emp, iso(now)))
    p = p or x.one("SELECT id, out_area_id, from_area_id, planned_by AS by_user, 'pickup' AS kind, purpose FROM pickup_assignments "
                   "WHERE employee_id=? AND status='PLANNED'", (emp,))
    if p:
        n = x.one("SELECT name FROM areas WHERE id=?", (p["out_area_id"],)) if p["out_area_id"] else None
        p["out_name"] = (n["name"] if n else p["purpose"]).upper()
    return p


def cancel_out(x: Ctx, p: dict, reason: str) -> None:
    if p["kind"] == "permit":
        x.ex("UPDATE exit_permits SET status='CANCELLED' WHERE id=?", (p["id"],))
    else:
        x.ex("UPDATE pickup_assignments SET status='CANCELLED', cancelled_reason=? WHERE id=?", (reason, p["id"]))
    audit(x, "OUT_CANCELLED", "employees", None, reason, p, None)


# ---------------------------------------------------------------- supervisor: assign an OUT (pickup / lunch / other)
OUT_PURPOSES = {"PICKUP": "PICKUP", "LUNCH": "LUNCH", "OTHER": "OTHER"}


def assign_out(x: Ctx, a: dict) -> dict:
    """Supervisor allows an MP out once: PICKUP / OTHER (pickup plan) or LUNCH (exit permit). Shift end needs no assignment."""
    require(x.has("admin", "supervisor"), x, "assign_out", purpose=a.get("purpose"))
    out_area = None
    if a.get("out_area_id"):   # OUT department made by admin (Areas -> OUT type); its type decides the rule
        out_area = x.one("SELECT id, name, out_purpose FROM areas WHERE id=? AND is_active=1 AND out_purpose IS NOT NULL", (a["out_area_id"],))
        if not out_area:
            raise BadInput("OUT option nahi mila (Admin -> Areas mein OUT type wala area banaiye)")
        purpose = out_area["out_purpose"]
    else:
        purpose = str(a.get("purpose") or "").upper()
        if purpose not in OUT_PURPOSES:
            raise BadInput("Purpose must be PICKUP, LUNCH or OTHER")
        out_area = x.one("SELECT id, name, out_purpose FROM areas WHERE is_active=1 AND out_purpose=? ORDER BY name LIMIT 1", (purpose,))
    emp, reason, info, not_found = _identify(x, a)
    e = _employee(x, emp)
    if not emp:
        return {"ok": True, "matched": False, "reason": reason, "employee": None, "result": result(not_found, reason or "", "red", True)}
    now = utcnow()
    key = (emp, "out:" + purpose + ":" + str(a.get("out_area_id") or ""))
    win = s_int(x, "dc_repeat_seconds", 120)
    ver = (x.one("SELECT version FROM mp_current_state WHERE employee_id=?", (emp,)) or {}).get("version")
    with _deploy_lock:
        prev = _deploy_recent.get(key)
        if prev and (now - prev[0]).total_seconds() < win and prev[2] == ver:
            return {"ok": True, "matched": True, "employee": e, "result": prev[1], "repeat": True}

    s = x.one("SELECT status, presence, attendance_id, assignment_id FROM mp_current_state WHERE employee_id=?", (emp,))
    # the area that sends the MP out: only that area can take him back before he leaves
    cur = x.one("SELECT area_id FROM work_assignments WHERE id=?", (s["assignment_id"],)) if s["assignment_id"] else None
    from_area = a.get("area_id") or (cur["area_id"] if cur else None)
    label = (out_area["name"] if out_area else purpose).upper()
    oaid = out_area["id"] if out_area else None
    sup_area = a.get("area_id") or a.get("_deploy_area")
    here = x.one("SELECT name FROM areas WHERE id=?", (cur["area_id"],)) if cur and s["status"] == "WORKING" and sup_area and cur["area_id"] != sup_area else None
    if s["presence"] != "INSIDE":
        res = result("DC IN NAHI HUA", "MP DC ke andar nahi hai", "red", True)
    elif here:   # MP is deployed in another area: that area must hand him over first
        res = result("HANDOVER CHAHIYE", f"MP abhi {here['name']} mein hai — {here['name']} ke supervisor se handover lijiye", "red", True)
    elif purpose == "LUNCH" and x.one("SELECT 1 FROM exit_permits WHERE employee_id=? AND status='PENDING' AND valid_until >= ?", (emp, iso(now))):
        res = result("PEHLE SE ASSIGNED", "LUNCH OUT already assigned hai", "green")
    elif purpose == "LUNCH" and lunch_left(x, emp, s, now)[0] <= 0:
        res = result("LUNCH ALREADY DONE", lunch_left(x, emp, s, now)[1], "red", True)
    elif purpose == "LUNCH":
        mins = s_int(x, "dc_out_permit_valid_minutes", 120)
        pid = new_id()
        x.ex("INSERT INTO exit_permits(id, employee_id, purpose, created_by, created_at, valid_until, out_area_id, from_area_id) "
             "VALUES (?,?,?,?,?,?,?,?)", (pid, emp, "LUNCH", x.uid, iso(now), iso(now + timedelta(minutes=mins)), oaid, from_area))
        audit(x, "OUT_ASSIGNED", "employees", emp, None, None, {"purpose": "LUNCH", "permit": pid})
        left, _ = lunch_left(x, emp, s, now)
        res = result("OUT ASSIGNED", f"{label} · {int(left)} min lunch baaki · gate pe {mins} min tak valid")
    else:
        active = x.one("SELECT purpose FROM pickup_assignments WHERE employee_id=? AND status IN ('PLANNED','OUT')", (emp,))
        if active:
            res = result("PEHLE SE ASSIGNED", f"{active['purpose']} already assigned hai", "green")
        else:
            try:
                pr = plan_pickup(x, {"p_employee_id": emp, "p_purpose": purpose,
                                "p_route_ref": (a.get("route_ref") or "").strip() or None,
                                "p_destination": (a.get("destination") or "").strip() or (out_area["name"] if out_area else ("Pickup" if purpose == "PICKUP" else "Other work")),
                                "p_handover_required": a.get("handover_required") if a.get("handover_required") is not None
                                else (False if a.get("area_id") else None),
                                # from the supervisor app: MP comes back straight into this supervisor's area
                                "p_next_area_id": a.get("area_id") or None})
                x.ex("UPDATE pickup_assignments SET out_area_id=?, from_area_id=? WHERE id=?", (oaid, from_area, pr.get("pickup_id")))
                audit(x, "OUT_ASSIGNED", "employees", emp, None, None, {"purpose": purpose, "out_area_id": oaid})
                res = result("OUT ASSIGNED", label + (f" · {a.get('route_ref')}" if a.get("route_ref") else ""))
            except AppError as err:
                msg = {"HANDOVER_PENDING": "Handover pending hai", "HANDOVER_IN_PROGRESS": "Handover chal raha hai"}.get(s["status"], err.message)
                res = result("OUT ASSIGN NAHI HUA", msg, "red", True)
    if not res["alarm"]:
        auto_resolve(x, f"IDLE_UNASSIGNED:{emp}", "OUT assigned")
    with _deploy_lock:
        if not res["alarm"]:
            for k in [k for k in _deploy_recent if k[0] == emp]:   # a new action replaces the MP's older repeat answers
                _deploy_recent.pop(k, None)
            _deploy_recent[key] = (now, res, (x.one("SELECT version FROM mp_current_state WHERE employee_id=?", (emp,)) or {}).get("version"))
    return {"ok": True, "matched": True, "employee": e, "result": res, "match": info}


# ---------------------------------------------------------------- admin: delete employees with their whole history
def purge_employees(x: Ctx, ids: list[str], all_logs: bool = False) -> int:
    """Remove employees and everything recorded about them (gate scans, movements, assignments, breaks, pickups,
    handovers, alerts, OUT permits, face data). Audit log keeps a note of the deletion. all_logs=True also clears
    gate scans of unknown faces, so only new (current) logs remain."""
    if not ids and not all_logs:
        return 0
    q = ",".join("?" * len(ids)) or "''"
    x.ex("UPDATE meta SET value='1' WHERE key='purge_demo'")        # lets append-only logs be deleted for this purge only
    try:
        hids = [r["id"] for r in x.rows(f"SELECT id FROM handover_records WHERE handing_employee_id IN ({q}) "
                                         f"OR received_by_employee_id IN ({q})", ids + ids)]
        hq = ",".join("?" * len(hids)) or "''"
        for sql, p in [
            (f"DELETE FROM alerts WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM mp_current_state WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM movement_events WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM handover_events WHERE handover_id IN ({hq}) OR actor_employee_id IN ({q})", hids + ids),
            (f"DELETE FROM handover_items WHERE handover_id IN ({hq})", hids),
            (f"UPDATE handover_items SET received_by_employee_id=NULL WHERE received_by_employee_id IN ({q})", ids),
            (f"DELETE FROM handover_records WHERE id IN ({hq})", hids),
            (f"DELETE FROM break_records WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM pickup_assignments WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM work_assignments WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM shift_attendance WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM gate_events WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM correction_requests WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM exit_permits WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM area_transfers WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM face_templates WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM users WHERE role='mp' AND employee_id IN ({q})", ids),
            (f"UPDATE users SET employee_id=NULL WHERE employee_id IN ({q})", ids),
            (f"DELETE FROM employees WHERE id IN ({q})", ids),
        ]:
            x.ex(sql, p)
        if all_logs:
            x.ex("DELETE FROM gate_events WHERE employee_id IS NULL")
            x.ex("DELETE FROM alerts WHERE employee_id IS NULL AND coalesce(entity_type, '') <> 'device'")
    finally:
        x.ex("UPDATE meta SET value='0' WHERE key='purge_demo'")
    x.ex("INSERT INTO meta(key, value) VALUES ('face_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")
    for i in ids:
        (photo_dir() / f"{i}.jpg").unlink(missing_ok=True)
    if all_logs and snap_dir().exists():   # gate camera snapshots of old scans
        for day in snap_dir().iterdir():
            if day.is_dir():
                for f in day.glob("*.jpg"):
                    f.unlink(missing_ok=True)
    audit(x, "EMPLOYEES_PURGED", "employees", ids[0] if len(ids) == 1 else None, "Deleted by admin with history",
          None, {"employees": len(ids), "all_logs": all_logs})
    return len(ids)
