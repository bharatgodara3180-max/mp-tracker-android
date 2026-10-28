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
        f.nets.faceRecognitionNet.loadFromUri(base),
      ]);
      // warm-up: the first run of each network compiles GPU shaders (slow); do it now, not on the first person
      try {
        const c = document.createElement('canvas'); c.width = 160; c.height = 160;
        const g = c.getContext('2d'); if (g) { g.fillStyle = '#888'; g.fillRect(0, 0, 160, 160); }
        await f.detectAllFaces(c, new f.TinyFaceDetectorOptions({ inputSize: DETECT_SIZE, scoreThreshold: 0.5 }));
        await f.detectFaceLandmarks(c);
        await f.computeFaceDescriptor(c);
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
    audio: false, video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
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
/** Consistent samples averaged per scan (2 = fast, still steady). */
export const SAMPLES_NEEDED = 2;
