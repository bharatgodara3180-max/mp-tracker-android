"""MP Tracker — standalone FastAPI service (default port 8010).

Serves the React app at "/" and the JSON API under /api. Runs fully on-premise:
SQLite database, in-process alert sweeper and daily backups, long-poll live updates.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import shutil
import secrets
import sqlite3
import threading
import time
import traceback
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, earlyleave, engine, face, facengine, hrsync, queries, transfer
from .adapters import AdapterError, get_adapter, order_for_ingest
from .db import new_id, now_iso, utcnow
from .engine import AppError, Ctx, Forbidden, log_security_event
from .security import hash_password, make_token, new_device_secret, read_token, verify_device, verify_password


# ---------------------------------------------------------------- live-update bus (long poll)
class Bus:
    def __init__(self) -> None:
        self.version = int(time.time() * 1000)   # new base after every restart -> clients refetch
        self.loop: asyncio.AbstractEventLoop | None = None
        self.event: asyncio.Event | None = None

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.event = asyncio.Event()

    def bump(self) -> None:
        self.version += 1
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._wake)

    def _wake(self) -> None:
        ev, self.event = self.event, asyncio.Event()
        if ev:
            ev.set()

    async def wait(self, since: int, timeout: float) -> int:
        if since != self.version or self.event is None:
            return self.version
        try:
            await asyncio.wait_for(self.event.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return self.version


bus = Bus()
db.on_commit(bus.bump)


# ---------------------------------------------------------------- background jobs
def _sweep_once() -> None:
    with db.write() as c:
        engine.sweep_alerts(Ctx(c, None))


def _backup_once() -> None:
    day = utcnow().strftime("%Y-%m-%d")
    target = config.BACKUP_DIR / f"mp_tracker_{day}.db"
    if not target.exists():
        db.backup(target)
    cutoff = time.time() - config.BACKUP_KEEP_DAYS * 86400
    for f in config.BACKUP_DIR.glob("mp_tracker_*.db"):
        if f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)
    with db.read() as c:
        keep = engine.s_int(Ctx(c, None), "face_snapshot_keep_days", 30)
    face.cleanup_snapshots(keep)


async def _loop(fn: Callable[[], None], every: float, label: str) -> None:
    while True:
        try:
            await asyncio.to_thread(fn)
        except Exception as e:  # keep running; visible in the server console
            print(f"[{label}] error: {e}")
        await asyncio.sleep(every)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    hrsync.ensure()
    with db.write(notify=False) as _c:
        earlyleave.ensure(_c)
    bus.attach(asyncio.get_running_loop())
    tasks = []
    if not getattr(app.state, "disable_jobs", False):
        threading.Thread(target=facengine.ready, daemon=True).start()     # load the face models now, so the first scan is not slow
        tasks = [asyncio.create_task(_loop(_sweep_once, config.SWEEP_SECONDS, "sweep")),
                 asyncio.create_task(_loop(_backup_once, 3600, "backup")),
                 asyncio.create_task(_loop(hrsync.auto_once, 300, "hrsync"))]     # HR sheet -> employees, every 5 minutes (after the first manual sync)
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="MP Tracker", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
# Android app: its pages run from http://localhost inside the app and call this server directly.
# Only that origin is allowed; auth is the X-MP-Token header (no cookies), so this opens nothing for other sites.
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost", "https://localhost", "capacitor://localhost"],
                   allow_methods=["*"], allow_headers=["*"], max_age=86400)


def _log_error(request: Request, exc: BaseException) -> None:
    """Unexpected server errors go to data/logs/errors.log (the service runs hidden under Task Scheduler)."""
    try:
        d = config.DATA_DIR / "logs"
        d.mkdir(parents=True, exist_ok=True)
        f = d / "errors.log"
        if f.exists() and f.stat().st_size > 5_000_000:
            f.replace(d / "errors.old.log")
        with f.open("a", encoding="utf-8") as out:
            out.write(f"\n[{now_iso()}] {request.method} {request.url.path}\n")
            out.write("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    except Exception:
        pass


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    _log_error(request, exc)
    print(f"[error] {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse(status_code=500, content={"detail": {
        "code": "SERVER_ERROR",
        "message": f"Server error: {type(exc).__name__}: {str(exc)[:300]} (details in server\\data\\logs\\errors.log)"}})


# ---------------------------------------------------------------- auth
def _user_by_token(token: str | None) -> dict | None:
    if not token:
        return None
    p = read_token(token)
    if not p:
        return None
    with db.read() as c:
        u = db.one(c, "SELECT id, username, full_name, role, employee_id, is_active, token_version FROM users WHERE id=?", (p["sub"],))
    if not u or not u["is_active"] or u["token_version"] != p.get("tv") or u["role"] not in APP_ROLES:
        return None
    return u


APP_ROLES = ("admin", "ops_manager", "supervisor", "gate_operator", "ld")   # "mp" logins are switched off
# Admin dropdown extras: stored as gate_operator + gate_access (IN / OUT), so every other role check keeps working
GATE_VIRTUAL = {"gate_operator_in": "IN", "gate_operator_out": "OUT"}


def _set_gate_dirs(x, uid: str, role_in: str | None) -> None:
    """role_in: gate_operator_in / gate_operator_out / gate_operator (= both) -> rewrite this user's gate_access rows."""
    x.ex("DELETE FROM gate_access WHERE user_id=?", (uid,))
    if role_in in GATE_VIRTUAL:
        x.ex("INSERT OR IGNORE INTO gate_access(user_id, direction) VALUES (?,?)", (uid, GATE_VIRTUAL[role_in]))
VIEW_ONLY_ROLES = ("ops_manager",)
# L&D login (role "ld", earlier "hr"): ONLY adding an employee + enrolling a face. Every other endpoint is refused for it.
HR_PATHS = ("/api/auth/", "/api/face/enrollments", "/api/face/enroll", "/api/face/check-photo", "/api/face/photo/", "/api/gate/employees")


# Gate tablet without a login: it opens a fixed link holding its device code + kiosk key and sends
# "kiosk:<device>:<key>" as its token. That identity can only use these endpoints.
KIOSK_PATHS = ("/api/face/scan", "/api/face/config", "/api/kiosk/heartbeat", "/api/face/photo/")


def _kiosk_identity(token: str, path: str) -> dict:
    try:
        _, code, key = token.split(":", 2)
    except ValueError:
        code, key = "", ""
    with db.read() as c:
        d = db.one(c, "SELECT device_code, kiosk_key, is_active FROM devices WHERE device_code=?", (code,))
    if not d or not d["is_active"] or not d["kiosk_key"] or not key or not hmac.compare_digest(d["kiosk_key"], key):
        raise HTTPException(401, {"code": "UNAUTHENTICATED", "message": "Gate link is not valid any more — ask the admin for the new link"})
    if not (path in KIOSK_PATHS or path.startswith("/api/face/photo/")):
        raise HTTPException(403, {"code": "FORBIDDEN", "message": "The gate link can only record DC IN / OUT"})
    return {"id": None, "username": f"kiosk:{code}", "full_name": f"Gate kiosk {code}", "role": "gate_operator",
            "employee_id": None, "kiosk_device": code}


def current_user(request: Request, x_mp_token: str | None = Header(default=None), authorization: str | None = Header(default=None)) -> dict:
    # X-MP-Token is what the web app sends (it never collides with the pendency server's
    # Basic Auth on the public /MP link); "Authorization: Bearer" is accepted for scripts.
    token = x_mp_token or (authorization.split(" ", 1)[1] if authorization and authorization.lower().startswith("bearer ") else None)
    if token and token.startswith("kiosk:"):
        return _kiosk_identity(token, request.url.path)
    u = _user_by_token(token)
    if not u:
        raise HTTPException(401, {"code": "UNAUTHENTICATED", "message": "Please sign in again"})
    if u["role"] == "ld" and not request.url.path.startswith(HR_PATHS):
        raise HTTPException(403, {"code": "FORBIDDEN", "message": "L&D login: sirf employee add aur face add"})
    return u


def require_roles(u: dict, *roles: str, action: str = "access") -> None:
    if u["role"] not in roles:
        with db.write(notify=False) as c:
            log_security_event(c, u, action, {})
        raise HTTPException(403, {"code": "FORBIDDEN", "message": f"You are not authorised to perform: {action}"})


def act(user: dict | None, fn: Callable[[Ctx], Any], notify: bool = True) -> Any:
    """Run fn in one serialised transaction; translate rule violations to HTTP errors."""
    try:
        with db.write(notify) as c:
            return fn(Ctx(c, user))
    except Forbidden as e:
        with db.write(notify=False) as c:
            log_security_event(c, user, e.action, e.details)
        raise HTTPException(403, {"code": e.code, "message": e.message})
    except AppError as e:
        raise HTTPException(e.status, {"code": e.code, "message": e.message})
    except sqlite3.IntegrityError as e:
        raise HTTPException(409, {"code": "CONFLICT", "message": f"Duplicate or conflicting record ({e})"})


def look(user: dict, fn: Callable[[Ctx], Any]) -> Any:
    try:
        with db.read() as c:
            return fn(Ctx(c, user))
    except Forbidden as e:
        raise HTTPException(403, {"code": e.code, "message": e.message})
    except AppError as e:
        raise HTTPException(e.status, {"code": e.code, "message": e.message})


_fails: dict[str, list[float]] = {}


@app.post("/api/auth/login")
def login(body: dict, request: Request):
    username = str(body.get("username") or "").strip()
    key = f"{username.lower()}|{request.client.host if request.client else ''}"
    recent = [t for t in _fails.get(key, []) if t > time.time() - 300]
    if len(recent) >= 5:
        raise HTTPException(429, {"code": "LOCKED", "message": "Too many failed attempts. Try again in 5 minutes."})
    with db.read() as c:
        u = db.one(c, "SELECT * FROM users WHERE username=?", (username,))
    if not u or not u["is_active"] or not verify_password(str(body.get("password") or ""), u["password_hash"]):
        _fails[key] = recent + [time.time()]
        raise HTTPException(401, {"code": "BAD_LOGIN", "message": "Wrong username or password"})
    if u["role"] not in APP_ROLES:
        raise HTTPException(403, {"code": "FORBIDDEN", "message": "MP login band hai — supervisor / admin se baat kariye"})
    _fails.pop(key, None)
    return {"token": make_token(u["id"], u["token_version"]),
            "user": {k: u[k] for k in ("id", "username", "full_name", "role", "employee_id")}}


@app.get("/api/auth/me")
def me(u: dict = Depends(current_user)):
    return {k: u[k] for k in ("id", "username", "full_name", "role", "employee_id", "is_active")}


@app.post("/api/auth/change-password")
def change_password(body: dict, u: dict = Depends(current_user)):
    new = str(body.get("new_password") or "")
    if len(new) < 4:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Password must be at least 4 characters"})
    with db.write(notify=False) as c:
        row = db.one(c, "SELECT password_hash FROM users WHERE id=?", (u["id"],))
        if not verify_password(str(body.get("old_password") or ""), row["password_hash"]):
            raise HTTPException(400, {"code": "BAD_INPUT", "message": "Current password is wrong"})
        c.execute("UPDATE users SET password_hash=?, token_version=token_version+1, updated_at=? WHERE id=?",
                  (hash_password(new), now_iso(), u["id"]))
        tv = db.one(c, "SELECT token_version FROM users WHERE id=?", (u["id"],))["token_version"]
    return {"ok": True, "token": make_token(u["id"], tv)}


def _is_local(request: Request) -> bool:
    """True only for a browser on the server PC itself — never for traffic arriving via a proxy."""
    if request.headers.get("x-forwarded-for") or request.headers.get("x-forwarded-host"):
        return False
    host = (request.headers.get("host") or "").split(":")[0]
    return bool(request.client and request.client.host in ("127.0.0.1", "::1", "testclient")
                and host in ("localhost", "127.0.0.1", "[::1]", "testserver"))


@app.get("/api/auth/setup-needed")
def setup_needed(request: Request):
    with db.read() as c:
        n = c.execute("SELECT count(*) FROM users").fetchone()[0]
    return {"setup_needed": n == 0, "local": _is_local(request)}


@app.post("/api/auth/setup")
def first_admin(body: dict, request: Request):
    """First admin can be created only from the server PC itself, and only once."""
    if not _is_local(request):
        raise HTTPException(403, {"code": "FORBIDDEN", "message": "First-time setup must be done on the server PC (http://localhost:8010)"})
    if len(str(body.get("password") or "")) < 4 or not body.get("username") or not body.get("full_name"):
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Name, username and a 4+ character password are required"})
    with db.write() as c:
        if c.execute("SELECT count(*) FROM users").fetchone()[0] > 0:
            raise HTTPException(409, {"code": "CONFLICT", "message": "Setup already done"})
        uid = new_id()
        c.execute("INSERT INTO users(id, username, full_name, role, password_hash, created_at, updated_at) VALUES (?,?,?, 'admin', ?,?,?)",
                  (uid, body["username"].strip(), body["full_name"].strip(), hash_password(body["password"]), now_iso(), now_iso()))
    return {"ok": True}


# ---------------------------------------------------------------- live reads
@app.get("/api/changes")
async def changes(since: int = 0, timeout: float = 25):
    """Long poll: returns as soon as anything changes (or after `timeout`). Works through any HTTP proxy."""
    v = await bus.wait(since, min(max(timeout, 1), 55))
    return {"version": v}


@app.get("/api/live")
def live(shift_id: str | None = None, include_demo: bool = True, u: dict = Depends(current_user)):
    return look(u, lambda x: {"rows": queries.live_rows(x), "kpis": queries.kpis(x, shift_id, include_demo)})


@app.get("/api/handovers")
def handovers(since: str | None = None, active: bool = False, u: dict = Depends(current_user)):
    return look(u, lambda x: queries.handover_rows(x, since=since, active_only=active))


@app.get("/api/handovers/{hid}/items")
def handover_items(hid: str, u: dict = Depends(current_user)):
    def f(x: Ctx):
        if not queries.handover_rows(x, hid=hid):
            raise engine.NotFound("Handover not found")
        return x.rows("SELECT * FROM handover_items WHERE handover_id=? ORDER BY created_at", (hid,))
    return look(u, f)


@app.get("/api/receivers")
def receivers(u: dict = Depends(current_user)):
    return look(u, lambda x: [r for r in queries.live_rows(x) if r["status"] in ("WORKING", "INSIDE_UNASSIGNED")]
                if x.role != "mp" else [])


@app.get("/api/profile/{emp}")
def profile(emp: str, hours: int = 24, u: dict = Depends(current_user)):
    return look(u, lambda x: queries.profile(x, emp, min(max(hours, 1), 24 * 31)))


@app.get("/api/alerts")
def alerts(show: str = "open", u: dict = Depends(current_user)):
    return look(u, lambda x: queries.alerts(x, show))


@app.get("/api/gate-log")
def gate_log(limit: int = 500, u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", "supervisor", "gate_operator", action="view_gate_log")
    return look(u, lambda x: queries.gate_log(x, min(limit, 5000)))


DEVICE_COLS = ("id, device_code, name, adapter, direction_mode, location_label, is_active, last_heartbeat_at, last_event_at, "
               "last_sync_at, pending_events_reported, firmware, (kiosk_key IS NOT NULL) AS has_kiosk_link, created_at, updated_at")


@app.get("/api/devices")
def devices(u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", "supervisor", "gate_operator", action="view_devices")
    return look(u, lambda x: x.rows(f"SELECT {DEVICE_COLS} FROM devices ORDER BY device_code"))


@app.get("/api/ref")
def ref(u: dict = Depends(current_user)):
    def f(x: Ctx):
        shifts = x.rows("SELECT * FROM shifts ORDER BY start_time")
        for s in shifts:
            s["crosses_midnight"] = engine.crosses_midnight(s)
        return {"areas": x.rows("SELECT * FROM areas ORDER BY (out_purpose IS NOT NULL), name"), "shifts": shifts,
                "supervisors": x.rows("SELECT id AS user_id, full_name, role FROM users WHERE role IN ('supervisor','ops_manager') "
                                      "AND is_active=1 ORDER BY full_name") if x.role != "mp" else []}
    return look(u, f)


@app.get("/api/settings")
def get_settings(u: dict = Depends(current_user)):
    return look(u, lambda x: [{**s, "value": json.loads(s["value"])} for s in x.rows("SELECT * FROM settings ORDER BY key")])


@app.get("/api/corrections")
def corrections(u: dict = Depends(current_user)):
    if u["role"] not in ("admin", "ops_manager"):
        return []
    return look(u, lambda x: [{**r, "payload": json.loads(r["payload"])} for r in
                              x.rows("SELECT * FROM correction_requests WHERE status='PENDING' ORDER BY requested_at")])


@app.get("/api/employees/lookup")
def lookup(q: str, u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", "supervisor", "gate_operator", action="lookup_employee")
    ql = q.strip().lower()
    return look(u, lambda x: [r for r in queries.live_rows(x) if r["employee_code"].lower() == ql or ql in r["full_name"].lower()][:5])


@app.get("/api/reports/{name}")
def report(name: str, date_from: str, date_to: str, u: dict = Depends(current_user)):
    try:
        return look(u, lambda x: queries.report(x, name, date_from, date_to))
    except ValueError as e:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": str(e)})


@app.post("/api/rpc/{name}")
def rpc(name: str, body: dict, u: dict = Depends(current_user)):
    if u["role"] in VIEW_ONLY_ROLES:
        require_roles(u, "admin", "supervisor", "gate_operator", action=name)   # logs + 403 "view only"
    fn = engine.RPC.get(name)
    if not fn:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": f"Unknown action {name}"})
    return act(u, lambda x: fn(x, body or {}))


@app.post("/api/sweep")
def sweep(u: dict = Depends(current_user)):
    require_roles(u, "admin", action="sweep_alerts")
    return act(None, lambda x: engine.sweep_alerts(x))


# ---------------------------------------------------------------- admin (configuration; audited)
CONFIG_TABLES = {
    "areas": ("code", "name", "kind", "out_purpose", "is_active"),
    "shifts": ("code", "name", "start_time", "end_time", "is_active"),
    "employees": ("employee_code", "full_name", "designation", "default_shift_id", "default_supervisor_user_id",
                  "badge_code", "device_person_id", "phone", "is_active"),
    "devices": ("device_code", "name", "adapter", "direction_mode", "location_label", "is_active"),
}


def _clean(table: str, body: dict) -> dict:
    out = {}
    for k in CONFIG_TABLES[table]:
        if k in body:
            v = body[k]
            if isinstance(v, bool):
                v = int(v)
            if isinstance(v, str):
                v = v.strip() or None
            out[k] = v
    return out


def _upsert(u: dict, table: str, body: dict, rid: str | None) -> dict:
    require_roles(u, "admin", action=f"admin_{table}")
    data = _clean(table, body)
    if table == "areas" and "code" in data and data["code"]:
        data["code"] = data["code"].upper()
    if table == "areas" and "kind" in data:
        k = re.sub(r"\s+", " ", str(data["kind"] or "")).strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9 _&/-]{0,29}", k):
            raise HTTPException(400, {"code": "BAD_INPUT", "message": "Kind: 1-30 letters/numbers (jaise PRIMARY, RTS, LOADING BAY)"})
        data["kind"] = k
    if table == "areas" and "out_purpose" in data:
        op = str(data["out_purpose"] or "").strip().upper() or None
        if op not in (None, "PICKUP", "LUNCH", "OTHER"):
            raise HTTPException(400, {"code": "BAD_INPUT", "message": "OUT type: PICKUP, LUNCH ya OTHER"})
        data["out_purpose"] = op

    def f(x: Ctx):
        t = now_iso()
        if rid:
            before = x.one(f"SELECT * FROM {table} WHERE id=?", (rid,))
            if not before:
                raise engine.NotFound("Not found")
            if data:
                x.ex(f"UPDATE {table} SET {', '.join(k + '=?' for k in data)}, updated_at=? WHERE id=?", (*data.values(), t, rid))
            new = rid
        else:
            new = new_id()
            extra = {"hmac_secret": new_device_secret()} if table == "devices" else {}
            cols = {**data, **extra, "id": new, "created_at": t, "updated_at": t}
            x.ex(f"INSERT INTO {table}({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", tuple(cols.values()))
            before = None
            if table == "employees":
                engine.ensure_state_row(x, new)
        after = x.one(f"SELECT * FROM {table} WHERE id=?", (new,))
        for row in (after, before):
            if row:
                row.pop("hmac_secret", None)
                row.pop("kiosk_key", None)
        engine.audit(x, f"CONFIG_{'UPDATE' if rid else 'INSERT'}", table, new, None, before, after)
        return after
    return act(u, f)


@app.get("/api/admin/employees")
def admin_employees(u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", action="admin_employees")
    return look(u, lambda x: x.rows("SELECT e.*, h.department, h.block, h.weekoff, h.shift_code AS hr_shift, h.hr_status "
                                    "FROM employees e LEFT JOIN employee_hr h ON h.employee_id = e.id ORDER BY e.employee_code"))


@app.post("/api/early-leave")
def early_leave_create(body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", "supervisor", action="early_leave_request")
    return act(u, lambda x: earlyleave.create(x, body))


@app.get("/api/early-leave")
def early_leave_list(u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", "supervisor", action="early_leave_list")
    return look(u, earlyleave.listing)


@app.post("/api/early-leave/{rid}/decide")
def early_leave_decide(rid: str, body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", action="early_leave_decide")
    return act(u, lambda x: earlyleave.decide(x, rid, bool(body.get("approve")), str(body.get("note") or "")))


@app.get("/api/admin/hr-sync")
def hr_sync_status(u: dict = Depends(current_user)):
    require_roles(u, "admin", action="hr_sync_status")
    with db.read() as c:
        on = engine.setting(Ctx(c, u), "hr_sync_enabled", False)
    return {"auto": bool(on), "running": hrsync.STATE["running"], "last": hrsync.STATE["last"]}


@app.post("/api/admin/hr-sync")
def hr_sync_run(body: dict, u: dict = Depends(current_user)):
    """Admin: pull the employee sheet now. dry=true only reports what would change. force=true allows a big deactivation."""
    require_roles(u, "admin", action="hr_sync_run")
    return hrsync.run(u, dry=bool(body.get("dry", True)), force=bool(body.get("force")), source="manual")


for _t in CONFIG_TABLES:
    def _mk(table: str):
        def create(body: dict, u: dict = Depends(current_user)):
            return _upsert(u, table, body, None)

        def update(rid: str, body: dict, u: dict = Depends(current_user)):
            return _upsert(u, table, body, rid)
        app.post(f"/api/admin/{table}", name=f"create_{table}")(create)
        app.put(f"/api/admin/{table}/{{rid}}", name=f"update_{table}")(update)
    _mk(_t)


@app.post("/api/admin/employees/bulk")
def bulk_employees(body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_employees_bulk")
    recs = body.get("rows") or []

    def f(x: Ctx):
        shifts = {s["code"].upper(): s["id"] for s in x.rows("SELECT id, code FROM shifts")}

        def shift_for(v: Any) -> str | None:
            """shift_code may be an existing code (S1) or a timing like 09:00-18:00 (shift created once)."""
            v = str(v or "").strip().upper().replace(" ", "").replace("TO", "-")
            if not v:
                return None
            if v in shifts:
                return shifts[v]
            m = re.fullmatch(r"(\d{1,2})[:.](\d{2})-(\d{1,2})[:.](\d{2})", v)
            if not m:
                raise engine.BadInput(f"Unknown shift '{v}' — use a shift code or a timing like 09:00-18:00")
            a, b = f"{int(m[1]):02d}:{m[2]}", f"{int(m[3]):02d}:{m[4]}"
            code = f"{a}-{b}"
            if code not in shifts:
                sid = new_id()
                x.ex("INSERT INTO shifts(id, code, name, start_time, end_time, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                     (sid, code, f"Shift {a} to {b}", a, b, now_iso(), now_iso()))
                shifts[code] = sid
            shifts[v] = shifts[code]
            return shifts[code]
        n = 0
        for r in recs:
            code, name = str(r.get("employee_code") or "").strip(), str(r.get("full_name") or "").strip()
            if not code or not name:
                continue
            data = {"full_name": name, "designation": r.get("designation") or None,
                    "default_shift_id": shift_for(r.get("shift_code") or r.get("shift_timing")),
                    "badge_code": r.get("badge_code") or code, "device_person_id": r.get("device_person_id") or None}
            ex = x.one("SELECT id FROM employees WHERE employee_code=?", (code,))
            t = now_iso()
            if ex:
                x.ex("UPDATE employees SET full_name=?, designation=?, default_shift_id=coalesce(?, default_shift_id), badge_code=?, "
                     "device_person_id=coalesce(?, device_person_id), updated_at=? WHERE id=?", (*data.values(), t, ex["id"]))
            else:
                eid = new_id()
                x.ex("INSERT INTO employees(id, employee_code, full_name, designation, default_shift_id, badge_code, device_person_id, "
                     "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", (eid, code, *data.values(), t, t))
                engine.ensure_state_row(x, eid)
            n += 1
        engine.audit(x, "CONFIG_BULK_IMPORT", "employees", None, None, None, {"rows": n})
        return {"ok": True, "imported": n}
    return act(u, f)


USER_COLS = "id, username, full_name, role, employee_id, is_active, created_at, updated_at"


@app.get("/api/admin/users")
def admin_users(u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_users")
    def f(x):
        users = x.rows(f"SELECT {USER_COLS} FROM users ORDER BY full_name")
        ga = x.rows("SELECT user_id, direction FROM gate_access")
        for r in users:   # show IN-only / OUT-only gate logins as gate_operator_in / gate_operator_out
            if r["role"] == "gate_operator":
                d = {g["direction"] for g in ga if g["user_id"] == r["id"]}
                if d == {"IN"}:
                    r["role"] = "gate_operator_in"
                elif d == {"OUT"}:
                    r["role"] = "gate_operator_out"
        return {"users": users, "supervisor_areas": x.rows("SELECT * FROM supervisor_areas"), "gate_access": ga}
    return look(u, f)


@app.post("/api/admin/users")
def create_user(body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_users")
    shown_role = body.get("role")
    if shown_role in GATE_VIRTUAL:
        body = {**body, "role": "gate_operator"}
    if body.get("role") not in APP_ROLES:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": f"Role must be one of {', '.join(APP_ROLES)}"})
    if len(str(body.get("password") or "")) < 4:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Password must be at least 4 characters"})

    def f(x: Ctx):
        uid = new_id()
        x.ex("INSERT INTO users(id, username, full_name, role, employee_id, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
             (uid, str(body.get("username") or "").strip(), str(body.get("full_name") or "").strip(), body.get("role"),
              body.get("employee_id") or None, hash_password(body["password"]), now_iso(), now_iso()))
        if shown_role in GATE_VIRTUAL:
            _set_gate_dirs(x, uid, shown_role)
        engine.audit(x, "USER_CREATED", "users", uid, None, None, x.one(f"SELECT {USER_COLS} FROM users WHERE id=?", (uid,)))
        return {"ok": True, "id": uid}
    return act(u, f)


@app.put("/api/admin/users/{uid}")
def update_user(uid: str, body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_users")
    fields = {k: body[k] for k in ("full_name", "username", "role", "employee_id", "is_active") if k in body}
    shown_role = fields.get("role")
    if shown_role in GATE_VIRTUAL:
        fields["role"] = "gate_operator"
    for k in ("full_name", "username"):
        if k in fields:
            fields[k] = re.sub(r"\s+", " ", str(fields[k] or "")).strip()
            if not fields[k]:
                raise HTTPException(400, {"code": "BAD_INPUT", "message": ("Name" if k == "full_name" else "Username") + " khaali nahi ho sakta"})
    if not fields:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Kuch change nahi bheja"})
    if "role" in fields and fields["role"] not in APP_ROLES:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": f"Role must be one of {', '.join(APP_ROLES)}"})
    if "is_active" in fields:
        fields["is_active"] = int(bool(fields["is_active"]))
    if "employee_id" in fields:
        fields["employee_id"] = fields["employee_id"] or None

    def f(x: Ctx):
        before = x.one(f"SELECT {USER_COLS} FROM users WHERE id=?", (uid,))
        if not before:
            raise engine.NotFound("User not found")
        if uid == u["id"] and (fields.get("role", "admin") != "admin" or fields.get("is_active", 1) == 0):
            raise engine.InvalidState("You cannot remove your own admin access")
        x.ex(f"UPDATE users SET {', '.join(k + '=?' for k in fields)}, token_version=token_version+1, updated_at=? WHERE id=?",
             (*fields.values(), now_iso(), uid))
        if "role" in fields:   # role dropdown decides the gate direction (plain gate_operator / other role = no limit)
            _set_gate_dirs(x, uid, shown_role)
        engine.audit(x, "USER_UPDATED", "users", uid, None, before, x.one(f"SELECT {USER_COLS} FROM users WHERE id=?", (uid,)))
        return {"ok": True}
    return act(u, f)


@app.post("/api/admin/users/{uid}/password")
def reset_password(uid: str, body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_users")
    if len(str(body.get("password") or "")) < 4:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Password must be at least 4 characters"})

    def f(x: Ctx):
        x.ex("UPDATE users SET password_hash=?, token_version=token_version+1, updated_at=? WHERE id=?",
             (hash_password(body["password"]), now_iso(), uid))
        engine.audit(x, "USER_PASSWORD_RESET", "users", uid, None)
        return {"ok": True}
    return act(u, f, notify=False)


@app.put("/api/admin/gate-access")
def gate_access(body: dict, u: dict = Depends(current_user)):
    """Admin: which gate directions (IN / OUT) a gate-operator login may record. Both ticked (or none) = both."""
    require_roles(u, "admin", action="admin_gate_access")
    direction = str(body.get("direction") or "").upper()
    if direction not in ("IN", "OUT"):
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "direction must be IN or OUT"})

    def f(x: Ctx):
        if not x.one("SELECT 1 FROM users WHERE id=?", (body.get("user_id"),)):
            raise engine.NotFound("User not found")
        if body.get("on"):
            x.ex("INSERT OR IGNORE INTO gate_access(user_id, direction) VALUES (?,?)", (body["user_id"], direction))
        else:
            x.ex("DELETE FROM gate_access WHERE user_id=? AND direction=?", (body["user_id"], direction))
        # the operator's session is kept: the rule is read on every scan
        engine.audit(x, "CONFIG_GATE_ACCESS", "gate_access", body.get("user_id"), None, None, body)
        return {"ok": True}
    return act(u, f)


@app.put("/api/admin/supervisor-areas")
def supervisor_area(body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_supervisor_areas")

    def f(x: Ctx):
        if body.get("on"):
            x.ex("INSERT OR IGNORE INTO supervisor_areas(user_id, area_id) VALUES (?,?)", (body["user_id"], body["area_id"]))
        else:
            x.ex("DELETE FROM supervisor_areas WHERE user_id=? AND area_id=?", (body["user_id"], body["area_id"]))
        engine.audit(x, "CONFIG_SUPERVISOR_AREA", "supervisor_areas", body.get("user_id"), None, None, body)
        return {"ok": True}
    return act(u, f)


# ---------------------------------------------------------------- delete (only records with no history)
# History tables are append-only, so anything they point to must stay; such records can only be deactivated.
HISTORY_REFS: dict[str, list[tuple[str, str, str]]] = {
    "employees": [("shift_attendance", "employee_id", "attendance"), ("gate_events", "employee_id", "gate scans"),
                  ("work_assignments", "employee_id", "assignments"), ("pickup_assignments", "employee_id", "pickups"),
                  ("break_records", "employee_id", "breaks"), ("handover_records", "handing_employee_id", "handovers"),
                  ("handover_records", "received_by_employee_id", "handovers received"),
                  ("handover_items", "received_by_employee_id", "handover items"), ("handover_events", "actor_employee_id", "handover events"),
                  ("movement_events", "employee_id", "movements"), ("correction_requests", "employee_id", "corrections"),
                  ("alerts", "employee_id", "alerts"), ("users", "employee_id", "a login user (delete that user first)")],
    "areas": [("work_assignments", "area_id", "assignments"), ("pickup_assignments", "receiving_area_id", "pickups"),
              ("pickup_assignments", "next_area_id", "pickups"), ("break_records", "resume_area_id", "breaks"),
              ("handover_records", "source_area_id", "handovers"), ("handover_records", "destination_area_id", "handovers"),
              ("movement_events", "area_id", "movements"), ("pickup_assignments", "out_area_id", "OUT entries"),
              ("exit_permits", "out_area_id", "OUT entries"), ("area_transfers", "from_area_id", "handovers"),
              ("area_transfers", "to_area_id", "handovers")],
    "shifts": [("employees", "default_shift_id", "employees on this shift (change their shift first)"),
               ("shift_attendance", "shift_id", "attendance")],
    "devices": [("gate_events", "device_id", "gate scans"), ("device_sync_logs", "device_id", "sync logs"),
                ("movement_events", "device_id", "movements")],
    "users": [("employees", "default_supervisor_user_id", "MPs who have this supervisor"), ("gate_events", "actor_user_id", "gate actions"),
              ("work_assignments", "assigned_by", "assignments"), ("work_assignments", "ended_by", "assignments"),
              ("work_assignments", "supervisor_user_id", "assignments"), ("pickup_assignments", "planned_by", "pickups"),
              ("pickup_assignments", "supervisor_user_id", "pickups"), ("break_records", "started_by", "breaks"),
              ("break_records", "ended_by", "breaks"), ("handover_records", "created_by", "handovers"),
              ("handover_records", "received_by_user_id", "handovers"), ("handover_records", "verified_by", "handovers"),
              ("handover_events", "actor_user_id", "handover events"), ("movement_events", "actor_user_id", "movements"),
              ("alerts", "acknowledged_by", "alerts"), ("alerts", "resolved_by", "alerts"),
              ("correction_requests", "requested_by", "corrections"), ("correction_requests", "decided_by", "corrections"),
              ("audit_logs", "actor_user_id", "audit entries"), ("security_events", "user_id", "security log entries"),
              ("face_templates", "created_by", "face enrolments")],
}


@app.post("/api/admin/employees/{rid}/purge")
def purge_employee(rid: str, body: dict, u: dict = Depends(current_user)):
    """Delete one employee WITH all their history. The admin must type the employee code to confirm."""
    require_roles(u, "admin", action="purge_employee")

    def f(x: Ctx):
        e = x.one("SELECT id, employee_code FROM employees WHERE id=?", (rid,))
        if not e:
            raise engine.NotFound("Employee not found")
        if str(body.get("confirm") or "").strip().upper() != e["employee_code"].upper():
            raise engine.BadInput(f"Confirm karne ke liye employee code {e['employee_code']} likhiye")
        return {"ok": True, "deleted": face.purge_employees(x, [rid])}
    return act(u, f)


@app.post("/api/admin/employees/bulk-remove")
def bulk_remove_employees(body: dict, u: dict = Depends(current_user)):
    """Admin: remove many employees (with their history) by employee code, one code per line."""
    require_roles(u, "admin", action="bulk_remove_employees")
    raw = body.get("codes") or []
    if isinstance(raw, str):
        raw = raw.splitlines()
    codes, seen = [], set()
    for c in raw:
        c = str(c or "").strip()
        if c and c.upper() not in seen:
            seen.add(c.upper())
            codes.append(c)
    if not codes:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Koi employee ID nahi mili"})
    if len(codes) > 5000:
        raise HTTPException(400, {"code": "BAD_INPUT", "message": "Ek baar me maximum 5000 IDs"})

    def f(x: Ctx):
        ids, found = [], set()
        for i in range(0, len(codes), 300):
            part = [c.upper() for c in codes[i:i + 300]]
            q = ",".join("?" * len(part))
            for r in x.rows(f"SELECT id, employee_code FROM employees WHERE UPPER(employee_code) IN ({q})", part):
                ids.append(r["id"])
                found.add(r["employee_code"].upper())
        for i in range(0, len(ids), 300):
            face.purge_employees(x, ids[i:i + 300])
        not_found = [c for c in codes if c.upper() not in found]
        return {"ok": True, "deleted": len(ids), "not_found": not_found}
    return act(u, f)


@app.delete("/api/admin/{table}/{rid}")
def admin_delete(table: str, rid: str, with_history: bool = False, u: dict = Depends(current_user)):
    require_roles(u, "admin", action=f"delete_{table}")
    if table not in HISTORY_REFS:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": f"Cannot delete from {table}"})

    def f(x: Ctx):
        row = x.one(f"SELECT * FROM {table} WHERE id=?", (rid,))
        if not row:
            raise engine.NotFound("Record not found")
        if table == "employees" and with_history:   # admin: employee + all his logs (the audit log records the delete)
            engine.purge_employees(x, [rid])
            (face.photo_dir() / f"{rid}.jpg").unlink(missing_ok=True)
            engine.audit(x, "EMPLOYEE_DELETE", "employees", rid, "Deleted with history", row, None)
            return {"ok": True}
        if table == "users":
            if rid == u["id"]:
                raise engine.BadInput("You cannot delete your own login")
            if row["role"] == "admin" and x.one("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1 AND id<>?", (rid,))["n"] == 0:
                raise engine.BadInput("This is the last admin — create another admin first")
        used = []
        for t, col, label in HISTORY_REFS[table]:
            n = x.one(f"SELECT COUNT(*) AS n FROM {t} WHERE {col}=?", (rid,))["n"]
            if n and label not in used:
                used.append(label)
        if table == "employees":
            st = x.one("SELECT status, last_gate_event_id FROM mp_current_state WHERE employee_id=?", (rid,))
            if st and (st["status"] != "NOT_CHECKED_IN" or st["last_gate_event_id"]):
                used.append("current status")
        if used:
            raise engine.Conflict("Delete nahi ho sakta — iski history hai (" + ", ".join(used) + "). "
                                  "History hamesha rakhi jaati hai; Edit karke Active hata dijiye (deactivate).")
        # owned rows that are not history
        if table == "employees":
            x.ex("DELETE FROM face_templates WHERE employee_id=?", (rid,))
            x.ex("DELETE FROM mp_current_state WHERE employee_id=?", (rid,))
            (face.photo_dir() / f"{rid}.jpg").unlink(missing_ok=True)
            x.ex("INSERT INTO meta(key, value) VALUES ('face_rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")
        if table in ("users", "areas"):
            x.ex(f"DELETE FROM supervisor_areas WHERE {'user_id' if table == 'users' else 'area_id'}=?", (rid,))
        if table == "users":
            x.ex("DELETE FROM gate_access WHERE user_id=?", (rid,))
        if table == "users":
            x.ex("DELETE FROM request_log WHERE user_id=?", (rid,))
            x.ex("UPDATE settings SET updated_by=NULL WHERE updated_by=?", (rid,))
        x.ex(f"DELETE FROM {table} WHERE id=?", (rid,))
        before = {k: v for k, v in row.items() if k not in ("hmac_secret", "kiosk_key", "password_hash")}
        engine.audit(x, "CONFIG_DELETE", table, rid, None, before, None)
        return {"ok": True}
    return act(u, f)


@app.post("/api/admin/devices/{did}/rotate-secret")
def rotate_secret(did: str, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="rotate_device_secret")
    secret = new_device_secret()

    def f(x: Ctx):
        if not x.one("SELECT 1 FROM devices WHERE id=?", (did,)):
            raise engine.NotFound("Device not found")
        x.ex("UPDATE devices SET hmac_secret=?, updated_at=? WHERE id=?", (secret, now_iso(), did))
        engine.audit(x, "DEVICE_SECRET_ROTATED", "devices", did, None)
        return {"ok": True, "secret": secret}
    return act(u, f, notify=False)


@app.post("/api/admin/devices/{did}/kiosk-link")
def kiosk_link(did: str, body: dict, u: dict = Depends(current_user)):
    """Key for the gate tablet's fixed link (no login). rotate=true makes the old link stop working."""
    require_roles(u, "admin", action="kiosk_link")

    def f(x: Ctx):
        d = x.one("SELECT id, device_code, adapter, kiosk_key FROM devices WHERE id=?", (did,))
        if not d:
            raise engine.NotFound("Device not found")
        if d["adapter"] != "face_kiosk":
            raise engine.BadInput("Gate links are only for face kiosk devices (adapter face_kiosk)")
        key = d["kiosk_key"]
        if not key or body.get("rotate"):
            key = secrets.token_urlsafe(18)
            x.ex("UPDATE devices SET kiosk_key=?, updated_at=? WHERE id=?", (key, now_iso(), did))
            engine.audit(x, "KIOSK_LINK_ROTATED" if body.get("rotate") else "KIOSK_LINK_CREATED", "devices", did, None)
        return {"ok": True, "device_code": d["device_code"], "key": key}
    return act(u, f, notify=False)


@app.put("/api/admin/settings/{key}")
def put_setting(key: str, body: dict, u: dict = Depends(current_user)):
    require_roles(u, "admin", action="admin_settings")

    def f(x: Ctx):
        before = x.one("SELECT value FROM settings WHERE key=?", (key,))
        if not before:
            raise engine.NotFound("Unknown setting")
        x.ex("UPDATE settings SET value=?, updated_at=?, updated_by=? WHERE key=?", (json.dumps(body.get("value")), now_iso(), u["id"], key))
        engine.audit(x, "CONFIG_SETTING", "settings", key, None, json.loads(before["value"]), body.get("value"))
        return {"ok": True}
    return act(u, f)


# ---------------------------------------------------------------- Asset Desk (same PC) <-> MP Tracker
def _internal_ok(key: str | None) -> None:
    if not config.INTERNAL_KEY or not key or not hmac.compare_digest(key, config.INTERNAL_KEY):
        raise HTTPException(403, {"code": "FORBIDDEN", "message": "Internal key missing or wrong"})


@app.post("/api/internal/identify")
def internal_identify(body: dict, x_internal_key: str | None = Header(default=None)):
    """Asset Desk asks 'who is this face?'. Lookup only - no gate IN/OUT is recorded."""
    _internal_ok(x_internal_key)
    body = body or {}
    face.prepare(body)
    return look({"role": "admin", "id": None}, lambda x: face.identify(x, body))


@app.get("/api/internal/employee")
def internal_employee(code: str, x_internal_key: str | None = Header(default=None)):
    _internal_ok(x_internal_key)
    def f(x: Ctx):
        r = x.one("SELECT id, employee_code AS emp_id, full_name AS name, designation, is_active FROM employees "
                  "WHERE upper(employee_code)=upper(?) OR badge_code=?", (code.strip(), code.strip()))
        return {"ok": True, "found": bool(r), "employee": r}
    return look({"role": "admin", "id": None}, f)


# ---------------------------------------------------------------- built-in face kiosk
@app.get("/api/face/config")
def face_config(u: dict = Depends(current_user)):
    require_roles(u, *face.SCANNERS, action="face_config")
    return look(u, face.config_for_kiosk)


@app.post("/api/face/check-photo")
def face_check_photo(body: dict, u: dict = Depends(current_user)):
    """Enrolment screen: the SAME strict photo check the Save step applies, run on every frame BEFORE it is kept
    (so 'too dark / blurry / not straight' is shown at once instead of after 3 photos). Nothing is saved."""
    require_roles(u, "admin", "supervisor", "gate_operator", "ops_manager", "ld", action="face_check_photo")
    with db.read() as c:
        th = engine.setting(Ctx(c, u), "face_quality", None)
    try:
        img = facengine.decode_image(face._jpeg((body or {}).get("image"), 6_000_000) or b"")
        ok, why, _ = facengine.quality(img, th if isinstance(th, dict) else None)
    except (facengine.EngineError, AppError) as e:
        return {"ok": False, "reason": getattr(e, "message", None) or str(e)}
    return {"ok": ok, "reason": why}


@app.post("/api/face/scan")
def face_scan(body: dict, u: dict = Depends(current_user)):
    body = body or {}
    if u.get("kiosk_device"):
        body["device_code"] = u["kiosk_device"]     # a gate link can only record for its own device
    face.prepare(body)                               # heavy part first, outside the database transaction
    return act(u, lambda x: face.scan(x, body))


@app.post("/api/face/deploy")
def face_deploy(body: dict, u: dict = Depends(current_user)):
    body = body or {}
    face.prepare(body)
    return act(u, lambda x: face.deploy(x, body))


@app.get("/api/supervisor/my-areas")
def supervisor_my_areas(u: dict = Depends(current_user)):
    return look(u, lambda x: face.my_areas(x))


@app.post("/api/supervisor/self-deploy")
def supervisor_self_deploy(body: dict, u: dict = Depends(current_user)):
    return act(u, lambda x: face.self_deploy(x, body or {}))


@app.post("/api/face/assign-out")
def face_assign_out(body: dict, u: dict = Depends(current_user)):
    body = body or {}
    face.prepare(body)
    return act(u, lambda x: face.assign_out(x, body))


@app.post("/api/transfer")
def transfer_create(body: dict, u: dict = Depends(current_user)):
    body = body or {}
    face.prepare(body)          # face picture -> signature (same as deploy / assign-out); ID-card scans pass through untouched
    return act(u, lambda x: transfer.create(x, body))


@app.get("/api/transfer/{direction}")
def transfer_list(direction: str, area_id: str, u: dict = Depends(current_user)):
    if direction not in ("incoming", "outgoing"):
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "incoming or outgoing"})
    return look(u, lambda x: transfer.listing(x, area_id, direction))


@app.post("/api/transfer/{tid}/receive")
def transfer_receive(tid: str, body: dict, u: dict = Depends(current_user)):
    return act(u, lambda x: transfer.receive(x, tid, body or {}))


@app.post("/api/transfer/{tid}/reject")
def transfer_reject(tid: str, body: dict, u: dict = Depends(current_user)):
    return act(u, lambda x: transfer.reject(x, tid, body or {}))


@app.get("/api/face/enrollments")
def face_enrollments(u: dict = Depends(current_user)):
    return look(u, face.enrollments)


@app.get("/api/gate/employees")
def gate_find_employees(q: str = "", u: dict = Depends(current_user)):
    return look(u, lambda x: face.find_employees(x, q))


@app.post("/api/gate/employees")
def gate_add_employee(body: dict, u: dict = Depends(current_user)):
    return act(u, lambda x: face.add_employee(x, body or {}))


@app.post("/api/face/enroll")
def face_enroll(body: dict, u: dict = Depends(current_user)):
    return act(u, lambda x: face.enroll(x, body or {}))


@app.delete("/api/face/enroll/{emp}")
def face_unenroll(emp: str, u: dict = Depends(current_user)):
    return act(u, lambda x: face.unenroll(x, emp))


@app.get("/api/face/photo/{emp}")
def face_photo(emp: str, u: dict = Depends(current_user)):
    require_roles(u, *face.SCANNERS, "ld", action="face_photo")
    p = face.photo_dir() / f"{emp}.jpg"
    if not re.fullmatch(r"[0-9a-f-]{36}", emp) or not p.exists():
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "No photo"})
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@app.get("/api/face/snap/{day}/{name}")
def face_snap(day: str, name: str, u: dict = Depends(current_user)):
    require_roles(u, "admin", "ops_manager", "supervisor", action="face_snapshot")
    p = face.snapshot_path(f"{day}/{name}")
    if not p:
        raise HTTPException(404, {"code": "NOT_FOUND", "message": "Snapshot not found (may have expired)"})
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


# ---------------------------------------------------------------- gate devices (HMAC, no user login)
def _device_auth(request: Request, raw: bytes) -> dict:
    code = (request.headers.get("x-device-code") or "").strip()
    with db.read() as c:
        d = db.one(c, "SELECT * FROM devices WHERE device_code=?", (code,)) if code else None
    if not d or not d["is_active"] or not d["hmac_secret"]:
        raise HTTPException(401, {"error": "Unknown or disabled device"})
    good, why = verify_device(d["hmac_secret"], raw, request.headers.get("x-signature"), request.headers.get("x-timestamp"))
    if not good:
        raise HTTPException(401, {"error": f"Signature rejected: {why}"})
    return d


@app.post("/api/device/events")
async def device_events(request: Request):
    raw = await request.body()
    d = _device_auth(request, raw)
    try:
        body = json.loads(raw or b"{}")
        events = order_for_ingest(get_adapter(d["adapter"])(body))
    except json.JSONDecodeError:
        return JSONResponse({"error": "Invalid JSON"}, 400)
    except AdapterError as e:
        return JSONResponse({"error": str(e)}, e.status)

    def apply_all() -> list[dict]:
        out = []
        for ev in events:   # strictly in capture order; one failure never blocks the rest
            try:
                r = act(None, lambda x, ev=ev: engine.ingest_device_event(x, d, ev))
                out.append({"event_id": ev["device_event_id"], **r})
            except HTTPException as e:
                det = e.detail if isinstance(e.detail, dict) else {"message": str(e.detail)}
                out.append({"event_id": ev["device_event_id"], "ok": False, "processing_status": "ERROR",
                            "error": det.get("message"), "retry": e.status_code >= 500})
            except Exception as e:
                out.append({"event_id": ev["device_event_id"], "ok": False, "processing_status": "ERROR", "error": str(e), "retry": True})
        try:
            act(None, lambda x: engine.log_device_sync(x, d["device_code"], out), notify=False)
        except Exception:
            pass
        return out

    results = await asyncio.to_thread(apply_all)
    return {"ok": True, "received": len(events), "acked": [r["event_id"] for r in results if not r.get("retry")],
            "retry": [r["event_id"] for r in results if r.get("retry")], "results": results}


@app.post("/api/device/heartbeat")
async def device_hb(request: Request):
    raw = await request.body()
    d = _device_auth(request, raw)
    try:
        b = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        b = {}
    pending = b.get("pending_events")
    return await asyncio.to_thread(act, None, lambda x: engine.device_heartbeat(
        x, d["device_code"], b.get("firmware"), None if pending is None else int(pending)), False)


@app.post("/api/kiosk/heartbeat")
def kiosk_hb(body: dict, u: dict = Depends(current_user)):
    code = u.get("kiosk_device") or body.get("device_code")
    return act(u, lambda x: engine.device_heartbeat(x, code, body.get("firmware") or "web-kiosk", body.get("pending_events")), notify=False)


@app.get("/api/health")
def health():
    with db.read() as c:
        c.execute("SELECT 1")
    return {"ok": True, "time": now_iso(), "version": bus.version}


# ---------------------------------------------------------------- frontend
if config.STATIC_DIR.exists() and (config.STATIC_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
else:
    @app.get("/")
    def no_frontend():
        return {"message": "API running. Frontend not built — copy the web build into server/static."}

