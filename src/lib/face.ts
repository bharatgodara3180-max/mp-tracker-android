/**
 * Face engine for the built-in kiosk and enrolment screens.
 * Runs fully in the tablet browser with models served by our own server (/models),
 * so it works without internet. Only a 128-number descriptor (+ optional small
 * snapshot) is sent to the server, where matching happens.
 */
import type * as FaceApi from '@vladmandic/face-api';

let api: typeof FaceApi | null = null;
let loading: Promise<typeof FaceApi> | null = null;

/** Detector input size (multiple of 32). 224 is ~2x faster than 320 and enough for a face filling the guide. */
export const DETECT_SIZE = 256;

export function modelBase(): string {
  return `${window.location.pathname.replace(/[^/]*$/, '')}models`;
}

export function loadFaceEngine(): Promise<typeof FaceApi> {
  if (api) return Promise.resolve(api);
  if (!loading) {
    loading = (async () => {
      const f = await import('@vladmandic/face-api');
      const tf = f.tf as unknown as { setBackend(b: string): Promise<boolean>; ready(): Promise<void> };
      try { await tf.setBackend('webgl'); } catch { /* falls back to cpu/wasm */ }
      await tf.ready();
      const base = modelBase();
      await Promise.all([
        f.nets.tinyFaceDetector.loadFromUri(base),
        f.nets.faceLandmark68Net.loadFromUri(base),
      ]);
      // warm-up: the first run of each network compiles GPU shaders (slow); do it now, not on the first person
      try {
        const c = document.createElement('canvas'); c.width = 160; c.height = 160;
        const g = c.getContext('2d'); if (g) { g.fillStyle = '#888'; g.fillRect(0, 0, 160, 160); }
        await f.detectAllFaces(c, new f.TinyFaceDetectorOptions({ inputSize: DETECT_SIZE, scoreThreshold: 0.5 }));
        await f.detectFaceLandmarks(c);
      } catch { /* warm-up is best effort */ }
      api = f;
      return f;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/** Camera needs HTTPS (or localhost). On plain http://<LAN-IP> the browser hides it. */
export function cameraProblem(): string | null {
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

export async function startCamera(video: HTMLVideoElement, facing: 'user' | 'environment'): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 540 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', 'true');
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

export interface FaceFrame {
  count: number;                 // faces detected
  score: number;                 // detector confidence of the main face
  sizeRatio: number;             // face width / frame width
  centered: boolean;
  ear: number | null;            // eye aspect ratio (blink detection)
  descriptor: Float32Array | null;
}

const point = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

/** Eye aspect ratio from the 68-point landmarks; ~0.3 open, < 0.2 closed. */
export function eyeAspectRatio(pts: { x: number; y: number }[]): number {
  const eye = (i: number) => {
    const [p1, p2, p3, p4, p5, p6] = pts.slice(i, i + 6);
    return (point(p2, p6) + point(p3, p5)) / (2 * point(p1, p4));
  };
  return (eye(36) + eye(42)) / 2;
}

/** Detect the main face; computes the descriptor only when `withDescriptor` (heavier). */
export async function analyse(video: HTMLVideoElement | HTMLImageElement, withDescriptor: boolean): Promise<FaceFrame> {
  const f = await loadFaceEngine();
  const opts = new f.TinyFaceDetectorOptions({ inputSize: DETECT_SIZE, scoreThreshold: 0.5 });
  const w = 'videoWidth' in video ? video.videoWidth : video.naturalWidth;
  const h = 'videoHeight' in video ? video.videoHeight : video.naturalHeight;
  const empty: FaceFrame = { count: 0, score: 0, sizeRatio: 0, centered: false, ear: null, descriptor: null };
  if (!w || !h) return empty;
  if (withDescriptor) {
    const all = await f.detectAllFaces(video, opts).withFaceLandmarks().withFaceDescriptors();
    if (!all.length) return empty;
    const main = all.reduce((a, b) => (b.detection.box.width > a.detection.box.width ? b : a));
    return describe(main.detection, main.landmarks.positions, main.descriptor, all.length, w, h);
  }
  const all = await f.detectAllFaces(video, opts).withFaceLandmarks();
  if (!all.length) return empty;
  const main = all.reduce((a, b) => (b.detection.box.width > a.detection.box.width ? b : a));
  return describe(main.detection, main.landmarks.positions, null, all.length, w, h);
}

function describe(det: FaceApi.FaceDetection, pts: { x: number; y: number }[], d: Float32Array | null, count: number, w: number, h: number): FaceFrame {
  const b = det.box;
  const cx = (b.x + b.width / 2) / w;
  const cy = (b.y + b.height / 2) / h;
  return {
    count, score: det.score, sizeRatio: b.width / w,
    centered: cx > 0.25 && cx < 0.75 && cy > 0.2 && cy < 0.8,
    ear: pts.length >= 48 ? eyeAspectRatio(pts) : null, descriptor: d,
  };
}

export function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

export function mean(ds: ArrayLike<number>[]): number[] {
  const out = new Array(ds[0].length).fill(0);
  for (const d of ds) for (let i = 0; i < d.length; i++) out[i] += d[i] / ds.length;
  return out;
}

/** Small JPEG of the current frame (for review/audit), ~15-30 KB. */
export function snapshot(src: HTMLVideoElement | HTMLImageElement, width = 320, quality = 0.7): string | null {
  const w = 'videoWidth' in src ? src.videoWidth : src.naturalWidth;
  const h = 'videoHeight' in src ? src.videoHeight : src.naturalHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round((h / w) * width);
  c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/** Tracks open -> closed -> open eyes across frames. */
export class BlinkDetector {
  private sawOpen = false;
  private sawClosed = false;
  done = false;
  push(ear: number | null) {
    if (ear === null || this.done) return;
    if (ear > 0.26) { if (this.sawClosed) this.done = true; else this.sawOpen = true; }
    else if (ear < 0.21 && this.sawOpen) this.sawClosed = true;
  }
  reset() { this.sawOpen = this.sawClosed = this.done = false; }
}

export const FACE_QUALITY = { minScore: 0.5, minSize: 0.16, consistent: 0.45 };

/* ---------- live tracking (kiosks): find the face anywhere, check distance/pose, then recognise ---------- */
export interface Box { x: number; y: number; width: number; height: number }
export interface Tracked {
  box: Box; score: number; vw: number; vh: number;
  others: number;                  // other faces of similar size (a second person close by)
  yaw: number; roll: number;       // rough head turn (0 = straight) and tilt in degrees
  pitch: number;                   // nose height between eyes and chin (~0.4 straight; smaller = looking up)
  ear: number | null;
  pts: { x: number; y: number }[]; // 68 landmarks (video pixels)
}

let far = 0;
/** Fast pass for every frame: detector + landmarks only (no recognition network). */
export async function track(video: HTMLVideoElement): Promise<Tracked | null> {
  const f = await loadFaceEngine();
  const vw = video.videoWidth; const vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return null;
  // near faces: quick 288 pass; nothing found -> every other frame a finer 448 pass, so far faces are found too
  far = (far + 1) % 4;
  let all = await f.detectAllFaces(video, new f.TinyFaceDetectorOptions({ inputSize: 288, scoreThreshold: 0.45 })).withFaceLandmarks();
  if (!all.length && far === 0) all = await f.detectAllFaces(video, new f.TinyFaceDetectorOptions({ inputSize: 448, scoreThreshold: 0.45 })).withFaceLandmarks();
  if (!all.length) return null;
  const main = all.reduce((a, b) => (b.detection.box.width > a.detection.box.width ? b : a));
  const b = main.detection.box;
  const pts = main.landmarks.positions;
  const avg = (i: number, n: number) => { let x = 0, y = 0; for (let k = i; k < i + n; k++) { x += pts[k].x; y += pts[k].y; } return { x: x / n, y: y / n }; };
  const eyeA = avg(36, 6); const eyeB = avg(42, 6);
  const mid = { x: (eyeA.x + eyeB.x) / 2, y: (eyeA.y + eyeB.y) / 2 };
  const ed = Math.max(1, Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y));
  return {
    box: { x: b.x, y: b.y, width: b.width, height: b.height }, score: main.detection.score, vw, vh,
    others: all.filter((o) => o !== main && o.detection.box.width > b.width * 0.6).length,
    yaw: (pts[30].x - mid.x) / ed,
    pitch: (pts[30].y - mid.y) / Math.max(1, pts[8].y - mid.y),
    roll: (Math.atan2(eyeB.y - eyeA.y, eyeB.x - eyeA.x) * 180) / Math.PI,
    ear: eyeAspectRatio(pts),
    pts: pts.map((q) => ({ x: q.x, y: q.y })),
  };
}

/** Kiosk rules for "the face is ready to be recognised" (any distance: the face is cut out and enlarged);
 *  returns the hint to show, or '' when ready. */
export const KIOSK_FACE = { minPx: 56, minScore: 0.5, maxYaw: 0.3, maxRoll: 18, steady: 0.25 };
export function readiness(t: Tracked | null): string {
  if (!t) return 'Camera ke saamne aaiye';
  if (t.others) return 'Ek baar mein ek vyakti';
  if (t.box.width < KIOSK_FACE.minPx) return 'Thoda paas aaiye';           // too few pixels to recognise
  const cut = t.box.x < 0 || t.box.y < 0 || t.box.x + t.box.width > t.vw || t.box.y + t.box.height > t.vh;
  if (cut) return 'Pura chehra camera mein laaiye';
  if (Math.abs(t.yaw) > KIOSK_FACE.maxYaw) return 'Seedha camera ki taraf dekhiye';
  if (Math.abs(t.roll) > KIOSK_FACE.maxRoll) return 'Sar seedha rakhiye';
  if (t.score < KIOSK_FACE.minScore) return 'Roshni mein seedha dekhiye';
  return '';
}

const crop = typeof document !== 'undefined' ? document.createElement('canvas') : null;
/** Recognise the tracked face: cut it out of the frame (with margin) and enlarge it, so near and far faces are
 *  recognised alike. Returns the 128-number descriptor, or null if no clear face in the cut. */
export async function describeAt(video: HTMLVideoElement, box: Box): Promise<Float32Array | null> {
  const f = await loadFaceEngine();
  if (!crop) return null;
  const m = 0.5;
  const sx = Math.max(0, box.x - box.width * m); const sy = Math.max(0, box.y - box.height * m * 1.1);
  const ex = Math.min(video.videoWidth, box.x + box.width * (1 + m)); const ey = Math.min(video.videoHeight, box.y + box.height * (1 + m * 0.9));
  const sw = ex - sx; const sh = ey - sy;
  if (sw < 20 || sh < 20) return null;
  const scale = 320 / sw;                                   // face ends up ~160 px wide whatever the distance
  crop.width = 320; crop.height = Math.round(sh * scale);
  const g = crop.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  g.drawImage(video, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  const r = await f.detectSingleFace(crop, new f.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 })).withFaceLandmarks().withFaceDescriptor();
  return r?.descriptor ?? null;
}

/** Best effort: point the camera's focus / exposure at the face (Android Chrome supports it on many phones). */
export function focusOn(stream: MediaStream | null, t: Tracked, mirror: boolean) {
  const track = stream?.getVideoTracks()[0];
  if (!track?.applyConstraints) return;
  let x = (t.box.x + t.box.width / 2) / t.vw;
  const y = (t.box.y + t.box.height / 2) / t.vh;
  if (mirror) x = Math.min(1, Math.max(0, x));
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const adv: Record<string, unknown>[] = [];
  if ('pointsOfInterest' in caps) adv.push({ pointsOfInterest: [{ x, y }] });
  if (Array.isArray(caps.focusMode) && (caps.focusMode as string[]).includes('continuous')) adv.push({ focusMode: 'continuous' });
  if (Array.isArray(caps.exposureMode) && (caps.exposureMode as string[]).includes('continuous')) adv.push({ exposureMode: 'continuous' });
  if (adv.length) void track.applyConstraints({ advanced: adv } as MediaTrackConstraints).catch(() => {});
}
/** Consistent samples averaged per scan (2 = fast, still steady). */
export const SAMPLES_NEEDED = 2;


/** The server recognises the face (ArcFace): the tablet only finds it and sends a small picture of it (face + margin, ~320 px wide). */
const cropCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export function faceCrop(video: HTMLVideoElement, box: Box, quality = 0.85): string | null {
  if (!cropCanvas) return null;
  const m = 0.5;
  const sx = Math.max(0, box.x - box.width * m); const sy = Math.max(0, box.y - box.height * m * 1.1);
  const ex = Math.min(video.videoWidth, box.x + box.width * (1 + m)); const ey = Math.min(video.videoHeight, box.y + box.height * (1 + m * 0.9));
  const sw = ex - sx; const sh = ey - sy;
  if (sw < 20 || sh < 20) return null;
  const sc = Math.min(1.5, 320 / sw);
  cropCanvas.width = Math.round(sw * sc); cropCanvas.height = Math.round(sh * sc);
  const g = cropCanvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  g.drawImage(video, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
  return cropCanvas.toDataURL('image/jpeg', quality);
}

/** Whole video frame as a JPEG (enrolment: the server checks the photo itself). */
export function frameJpeg(video: HTMLVideoElement, maxSide = 1280, quality = 0.92): string | null {
  const w = video.videoWidth; const h = video.videoHeight;
  if (!w || !h) return null;
  const sc = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
  c.getContext('2d')?.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/** Any picture (file / data URL / link already downloaded) -> JPEG data URL, at most `maxSide` px. */
export async function toJpeg(src: Blob | string, maxSide = 1600, quality = 0.92): Promise<string> {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally { if (typeof src !== 'string') URL.revokeObjectURL(url); }
}
