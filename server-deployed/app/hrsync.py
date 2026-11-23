"""Employee master from the Google Sheet (RDC AUDIT -> tab "MP_TRACKER_HR SHEET").

Safety rules (never broken):
  * nothing is ever deleted - no employee, no face template, no history;
  * the employee row is matched by employee_code (= "Valinor ID") and updated IN PLACE, so its id and faces stay;
  * a blank cell in the sheet never overwrites a value that is already stored;
  * an Inactive employee is only switched off when he is not inside the DC and has no active login;
  * a bad / half-loaded sheet (too few rows, wrong columns, login page) changes nothing;
  * too many deactivations in one run stop the run until an admin confirms (force).
Sheet must be viewable by link ("anyone with the link"). Extra fields (department, block, weekoff, sheet status)
are kept in the separate table employee_hr, so the employees table itself is not altered.
"""
from __future__ import annotations

import csv
import io
import re
import threading
import time
import urllib.parse
import urllib.request
from typing import Any

from . import config, db
from .db import new_id, now_iso
from .engine import Ctx, audit, ensure_state_row, setting

SHEET_ID = ""   # set the sheet id in Admin settings (key hr_sheet_id) - not kept in this public repo
SHEET_TAB = "MP_TRACKER_HR SHEET"
MIN_ROWS = 100            # a sheet with fewer valid rows is treated as a broken download
STATE: dict[str, Any] = {"last": None, "running": False}
_lock = threading.Lock()

_DDL = ("CREATE TABLE IF NOT EXISTS employee_hr (employee_id TEXT PRIMARY KEY, department TEXT, block TEXT, weekoff TEXT, "
        "shift_code TEXT, hr_status TEXT, synced_at TEXT)")


# ---------------------------------------------------------------- sheet
def _fetch(sheet_id: str, tab: str) -> str:
    url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet=" + urllib.parse.quote(tab))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 MPTracker-HRSync"})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    text = raw.decode("utf-8-sig", errors="replace")
    if text.lstrip()[:1] == "<":
        raise RuntimeError("Sheet CSV ki jagah web page aaya — sheet 'Anyone with the link can view' honi chahiye")
    return text


def _cell(row: list[str], i: int | None) -> str:
    return re.sub(r"\s+", " ", row[i]).strip() if i is not None and i < len(row) else ""


def parse(text: str) -> tuple[list[dict], dict]:
    rows = list(csv.reader(io.StringIO(text)))
    hi = next((i for i, r in enumerate(rows[:10]) if any(c.strip().lower() == "valinor id" for c in r)), None)
    if hi is None:
        raise RuntimeError("Sheet me 'Valinor ID' wala header nahi mila — tab ka naam / columns check kariye")
    head = {c.strip().lower(): i for i, c in enumerate(rows[hi])}
    need = [k for k in ("valinor id", "employee name", "current status") if k not in head]
    if need:
        raise RuntimeError("Sheet me ye columns nahi mile: " + ", ".join(need))
    col = lambda k: head.get(k)  # noqa: E731
    out, seen, stats = [], set(), {"blank_name": 0, "bad_id": 0, "duplicate": 0}
    for r in rows[hi + 1:]:
        code = re.sub(r"\s+", "", _cell(r, col("valinor id"))).upper()
        if not code:
            continue
        if not re.fullmatch(r"[A-Z0-9_-]{2,30}", code):
            stats["bad_id"] += 1
            continue
        name = _cell(r, col("employee name"))
        if len(name) < 2:
            stats["blank_name"] += 1
            continue
        if code in seen:
            stats["duplicate"] += 1
            continue
        seen.add(code)
        st = _cell(r, col("current status")).lower()
        active = True if st == "active" else (False if st.startswith("inactive") or st in ("left", "resigned", "absconded", "terminated") else None)
        out.append({"code": code, "name": name, "department": _cell(r, col("department")), "designation": _cell(r, col("designation")),
                    "shift": _cell(r, col("shift")).upper(), "weekoff": _cell(r, col("weekoff")), "block": _cell(r, col("blocks")),
                    "status": _cell(r, col("current status")), "active": active})
    return out, stats


# ---------------------------------------------------------------- plan (read only)
def plan(x: Ctx, recs: list[dict]) -> dict:
    emps = {r["employee_code"].upper(): r for r in x.rows(
        "SELECT e.id, e.employee_code, e.full_name, e.designation, e.default_shift_id, e.is_active, e.badge_code, "
        "s.presence FROM employees e LEFT JOIN mp_current_state s ON s.employee_id = e.id")}
    shifts = {s["code"].upper(): s["id"] for s in x.rows("SELECT id, code FROM shifts")}
    badges = {e["badge_code"] for e in emps.values() if e["badge_code"]}
    logins = {r["username"].upper() for r in x.rows("SELECT username FROM users WHERE is_active=1")}
    hr = {r["employee_id"]: r for r in x.rows("SELECT * FROM employee_hr")}
    p: dict[str, Any] = {"update": [], "create": [], "deactivate": [], "reactivate": [], "hr": [],
                         "skip_deactivate": [], "skip_new_inactive": 0, "unknown_shift": {}, "same": 0}
    for r in recs:
        e = emps.get(r["code"])
        sid = shifts.get(r["shift"]) if r["shift"] else None
        if r["shift"] and not sid:
            p["unknown_shift"][r["shift"]] = p["unknown_shift"].get(r["shift"], 0) + 1
        if not e:
            if r["active"] is False:
                p["skip_new_inactive"] += 1
                continue
            b = re.search(r"(\d+)$", r["code"])
            badge = b.group(1) if b and b.group(1) not in badges else None
            if badge:
                badges.add(badge)
            p["create"].append({**r, "shift_id": sid, "badge": badge})
            continue
        ch: dict[str, Any] = {}
        if r["name"] != e["full_name"]:
            ch["full_name"] = r["name"]
        if r["designation"] and r["designation"] != (e["designation"] or ""):
            ch["designation"] = r["designation"]
        if sid and sid != e["default_shift_id"]:
            ch["default_shift_id"] = sid
        if ch:
            p["update"].append({"id": e["id"], "code": r["code"], "changes": ch, "was": {k: e[k] for k in ch}})
        if r["active"] is False and e["is_active"]:
            if r["code"] in logins:
                p["skip_deactivate"].append({"code": r["code"], "name": e["full_name"], "why": "iska login chalu hai"})
            elif e["presence"] == "INSIDE":
                p["skip_deactivate"].append({"code": r["code"], "name": e["full_name"], "why": "abhi DC ke andar hai (agle sync me)"})
            else:
                p["deactivate"].append({"id": e["id"], "code": r["code"], "name": e["full_name"]})
        elif r["active"] is True and not e["is_active"]:
            p["reactivate"].append({"id": e["id"], "code": r["code"], "name": e["full_name"]})
        if not ch and not (r["active"] is False and e["is_active"]) and not (r["active"] is True and not e["is_active"]):
            p["same"] += 1
        h = hr.get(e["id"])
        want = (r["department"], r["block"], r["weekoff"], r["shift"], r["status"])
        have = (h["department"] or "", h["block"] or "", h["weekoff"] or "", h["shift_code"] or "", h["hr_status"] or "") if h else None
        if want != have:
            p["hr"].append({"id": e["id"], "r": r, "keep": h})
    return p


def _counts(p: dict) -> dict:
    return {"new": len(p["create"]), "updated": len(p["update"]), "deactivated": len(p["deactivate"]),
            "reactivated": len(p["reactivate"]), "details_changed": len(p["hr"]), "unchanged": p["same"],
            "skipped_deactivate": p["skip_deactivate"], "new_inactive_not_added": p["skip_new_inactive"],
            "unknown_shift_codes": p["unknown_shift"]}


def _changed(p: dict) -> bool:
    return bool(p["create"] or p["update"] or p["deactivate"] or p["reactivate"] or p["hr"])


# ---------------------------------------------------------------- apply (inside a write transaction)
def _apply(x: Ctx, p: dict) -> None:
    from . import face
    t = now_iso()
    for c in p["create"]:
        eid = new_id()
        x.ex("INSERT INTO employees(id, employee_code, full_name, designation, default_shift_id, badge_code, created_at, updated_at) "
             "VALUES (?,?,?,?,?,?,?,?)", (eid, c["code"], c["name"], c["designation"] or None, c["shift_id"], c["badge"], t, t))
        ensure_state_row(x, eid)
        p["hr"].append({"id": eid, "r": c, "keep": None})
    for u in p["update"]:
        sets = ", ".join(f"{k}=?" for k in u["changes"])
        x.ex(f"UPDATE employees SET {sets}, updated_at=? WHERE id=?", (*u["changes"].values(), t, u["id"]))
    for d in p["deactivate"]:
        x.ex("UPDATE employees SET is_active=0, updated_at=? WHERE id=?", (t, d["id"]))     # faces stay stored
    for d in p["reactivate"]:
        x.ex("UPDATE employees SET is_active=1, updated_at=? WHERE id=?", (t, d["id"]))
        ensure_state_row(x, d["id"])
    for h in p["hr"]:
        r = h["r"]
        x.ex("INSERT INTO employee_hr(employee_id, department, block, weekoff, shift_code, hr_status, synced_at) VALUES (?,?,?,?,?,?,?) "
             "ON CONFLICT(employee_id) DO UPDATE SET department=excluded.department, block=excluded.block, weekoff=excluded.weekoff, "
             "shift_code=excluded.shift_code, hr_status=excluded.hr_status, synced_at=excluded.synced_at",
             (h["id"], r["department"], r["block"], r["weekoff"], r["shift"], r["status"], t))
    if p["deactivate"] or p["reactivate"] or p["create"]:
        face._bump(x)           # face matcher reloads (deactivated people are not matched; their templates are NOT removed)
    audit(x, "HR_SHEET_SYNC", "employees", None, None, None, _counts(p))


# ---------------------------------------------------------------- run
def run(user: dict | None = None, dry: bool = True, force: bool = False, source: str = "manual") -> dict:
    if not _lock.acquire(blocking=False):
        return {"ok": False, "error": "Sync pehle se chal raha hai"}
    started = time.time()
    STATE["running"] = True
    res: dict[str, Any] = {"ok": False, "dry": dry, "source": source, "at": now_iso()}
    try:
        with db.write(notify=False) as c:
            c.execute(_DDL)
        with db.read() as c:
            x = Ctx(c, user)
            sid, tab = setting(x, "hr_sheet_id", SHEET_ID), setting(x, "hr_sheet_tab", SHEET_TAB)
        recs, stats = parse(_fetch(sid, tab))
        res["sheet_rows"] = len(recs)
        res["sheet_skipped"] = stats
        if len(recs) < MIN_ROWS:
            raise RuntimeError(f"Sheet me sirf {len(recs)} valid rows mili (kam se kam {MIN_ROWS} chahiye) — kuch nahi badla")
        with db.read() as c:
            x = Ctx(c, user)
            p = plan(x, recs)
            active = x.one("SELECT COUNT(*) AS n FROM employees WHERE is_active=1")["n"]
            prev = x.one("SELECT COUNT(*) AS n FROM employee_hr")["n"]
        if prev and len(recs) < 0.6 * prev:
            raise RuntimeError(f"Sheet me rows pichhli baar ({prev}) se bahut kam ({len(recs)}) — kuch nahi badla")
        res.update(_counts(p))
        res["sample"] = {"new": [f"{c['code']} {c['name']}" for c in p["create"][:15]],
                         "deactivate": [f"{d['code']} {d['name']}" for d in p["deactivate"][:15]],
                         "reactivate": [f"{d['code']} {d['name']}" for d in p["reactivate"][:15]],
                         "renamed": [f"{u['code']}: {u['was'].get('full_name')} → {u['changes']['full_name']}" for u in p["update"] if "full_name" in u["changes"]][:15]}
        limit = max(30, int(0.25 * active))
        if len(p["deactivate"]) > limit and not force:
            res["blocked"] = True
            raise RuntimeError(f"{len(p['deactivate'])} employees inactive hone wale hain (limit {limit}) — pehle dry run dekhiye, theek ho to 'Force' ke saath chalayiye")
        if dry:
            res["ok"] = True
            res["note"] = "Dry run — kuch nahi badla"
        elif not _changed(p):
            res["ok"] = True
            res["note"] = "Koi badlav nahi"
        else:
            if source != "auto":     # one safety copy of the database before a manual write
                try:
                    config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
                    db.backup(config.BACKUP_DIR / f"mp_tracker_before_hrsync_{time.strftime('%Y%m%d_%H%M%S')}.db")
                except Exception as e:   # backup trouble must not block, but is reported
                    res["backup_warning"] = str(e)
            with db.write() as c:
                x = Ctx(c, user)
                p2 = plan(x, recs)       # re-plan inside the write transaction (data may have changed meanwhile)
                _apply(x, p2)
                if source != "auto":     # from now on the server repeats the sync by itself every 5 minutes
                    x.ex("INSERT INTO settings(key, value, description, updated_at) VALUES ('hr_sync_enabled', 'true', 'HR sheet auto sync on', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value='true', updated_at=excluded.updated_at", (now_iso(),))
            res["ok"] = True
            res["note"] = "Sync ho gaya"
    except Exception as e:
        res["error"] = str(e)
    finally:
        res["seconds"] = round(time.time() - started, 1)
        STATE["last"] = res
        STATE["running"] = False
        _lock.release()
    return res


def ensure() -> None:
    with db.write(notify=False) as c:
        c.execute(_DDL)


def auto_once() -> None:
    """Called every 5 minutes by the server; runs only after an admin has done one successful manual sync."""
    with db.read() as c:
        on = setting(Ctx(c, None), "hr_sync_enabled", False)
    if on:
        run(None, dry=False, source="auto")
