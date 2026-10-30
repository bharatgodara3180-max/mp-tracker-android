# SFXBM — Android app (v1.01)

One app, one link box. Nothing is pre-filled: on first start enter a link and **Open**.

* **Asset Desk** (`https://<ngrok>/ASSETS/` or `http://<PC>:8060/ASSETS/`) and any other tool link — opens as it is.
  The link is remembered and opens automatically next time; press the Android **Back** button to return to the link box
  and enter a different one.
* **MP Tracker** (server address `…:8010`, `/MP`, or the Gate link) — the built-in screens below.

The MP part (what opens depends on the login — all logic is on the server):

* **Gate tablet (DC IN / OUT, no login)** — app setup → paste the Gate link from
  *Admin → Devices → GATE-FACE-TAB-01 → Gate link* and the server address.
* **Login** — enter the server address → sign in:
  * `supervisor` → select work area → entry page (Deploy / OUT assign by Face, QR or Manual) with
    Deploy list, Handover and Receive (notifications) icons.
  * `gate_operator` → DC IN / OUT only.
  * `admin` / `ops_manager` → dashboard (ops_manager view-only + reports).

The web app and face models are inside the APK, so it opens instantly and the camera works on the plain LAN
address (`http://<server-PC-IP>:8010`) — no HTTPS or Chrome flag needed.

Build: every push to `main` runs *.github/workflows/android.yml* on GitHub and publishes the signed APK `SFXBM-<version>.apk` under
**Releases** (version = `APP_VERSION` in the workflow, now 1.01). Signing key: `android/app/mptracker.keystore` (password in the repo secret `MP_STORE_PASSWORD`). Keep the
same key, otherwise a new APK will not install over the old one.

Web source lives in `src/` (same as `MPTracker/web/src`). `npm run build:app` builds the bundle for the APK.
