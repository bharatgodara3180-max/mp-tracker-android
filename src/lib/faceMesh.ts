/**
 * Face mesh look for enrolment (like a phone's Face ID screen): a fixed set of landmarks, joined by a
 * triangulation that is computed once and then follows the face.
 */
type P = { x: number; y: number };

/** Landmarks used for the mesh (jaw, brows, nose, eyes, mouth). */
export const MESH_IDX = [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 19, 21, 22, 24, 26, 27, 29, 31, 33, 35, 36, 39, 42, 45, 48, 51, 54, 57];

/** Delaunay triangulation (Bowyer-Watson) of a few dozen points -> triangles as index triples. */
export function delaunay(pts: P[]): [number, number, number][] {
  const n = pts.length;
  const minX = Math.min(...pts.map((p) => p.x)); const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x)); const maxY = Math.max(...pts.map((p) => p.y));
  const d = Math.max(maxX - minX, maxY - minY) * 20; const mx = (minX + maxX) / 2; const my = (minY + maxY) / 2;
  const all = [...pts, { x: mx - d, y: my - d }, { x: mx, y: my + d }, { x: mx + d, y: my - d }];
  let tris: [number, number, number][] = [[n, n + 1, n + 2]];
  const circ = (t: [number, number, number]) => {
    const [a, b, c] = t.map((i) => all[i]);
    const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(D) < 1e-9) return { x: 0, y: 0, r: Infinity };
    const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / D;
    const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / D;
    return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
  };
  for (let i = 0; i < n; i++) {
    const p = all[i];
    const bad = tris.filter((t) => { const c = circ(t); return Math.hypot(p.x - c.x, p.y - c.y) < c.r; });
    const edges: [number, number][] = [];
    for (const t of bad) for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]] as [number, number][]) {
      const k = edges.findIndex((f) => (f[0] === e[1] && f[1] === e[0]) || (f[0] === e[0] && f[1] === e[1]));
      if (k >= 0) edges.splice(k, 1); else edges.push(e);
    }
    tris = tris.filter((t) => !bad.includes(t));
    for (const e of edges) tris.push([e[0], e[1], i]);
  }
  return tris.filter((t) => t.every((i) => i < n));
}

/** Draw the mesh on a canvas laid over a video shown with object-fit: cover (mirrored for the front camera). */
export function drawMesh(cv: HTMLCanvasElement, video: HTMLVideoElement, pts: P[] | null, tris: [number, number, number][] | null,
  mirror: boolean, color: string) {
  const w = cv.clientWidth; const h = cv.clientHeight;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  if (!pts || !video.videoWidth) return;
  const sc = Math.max(w / video.videoWidth, h / video.videoHeight);
  const ox = (w - video.videoWidth * sc) / 2; const oy = (h - video.videoHeight * sc) / 2;
  const m = MESH_IDX.map((i) => {
    const x = pts[i].x * sc + ox;
    return { x: mirror ? w - x : x, y: pts[i].y * sc + oy };
  });
  g.lineWidth = 1.4; g.strokeStyle = color; g.globalAlpha = 0.75;
  g.beginPath();
  for (const [a, b, c] of tris ?? []) {
    g.moveTo(m[a].x, m[a].y); g.lineTo(m[b].x, m[b].y); g.lineTo(m[c].x, m[c].y); g.lineTo(m[a].x, m[a].y);
  }
  g.stroke();
  g.globalAlpha = 1; g.fillStyle = '#fff';
  for (const p of m) { g.beginPath(); g.arc(p.x, p.y, 2.6, 0, Math.PI * 2); g.fill(); }
}
