// 영상 위에 뼈대 그리기 (원본 engine.py의 _draw_visualization 역할)

const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

/** 영상이 object-fit: contain 으로 표시될 때 실제 그려지는 영역 */
export function fitRect(srcW, srcH, boxW, boxH) {
  const s = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

const bgrToCss = (c) => (Array.isArray(c) ? `rgb(${c[2]},${c[1]},${c[0]})` : "#4ade80");

export function drawPose(ctx, lms, { srcW, srcH, mirror, visualization, pointIndex, angles, alert }) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  if (!lms) return;
  const r = fitRect(srcW, srcH, W, H);
  const P = (i) => {
    const x = mirror ? 1 - lms[i].x : lms[i].x;
    return [r.x + x * r.w, r.y + lms[i].y * r.h];
  };
  const dpr = W / ctx.canvas.clientWidth || 1;

  // 전체 뼈대 (흐리게)
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  for (const [a, b] of BONES) {
    if ((lms[a].visibility ?? 1) < 0.3 || (lms[b].visibility ?? 1) < 0.3) continue;
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
  }

  // 운동별 강조선 (YAML visualization — 원본은 OpenCV BGR 색)
  const idx = (name) => pointIndex?.[name];
  ctx.lineWidth = 6 * dpr;
  for (const line of visualization?.lines || []) {
    const a = idx(line.points[0]), b = idx(line.points[1]);
    if (a == null || b == null) continue;
    ctx.strokeStyle = alert ? "#f87171" : bgrToCss(line.color);
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke();
  }
  for (const c of visualization?.circles || []) {
    const i = idx(c.point);
    if (i == null) continue;
    ctx.fillStyle = alert ? "#f87171" : bgrToCss(c.color);
    ctx.beginPath(); ctx.arc(...P(i), 7 * dpr, 0, Math.PI * 2); ctx.fill();
  }

  // 각도 숫자
  ctx.font = `${14 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  for (const d of visualization?.angle_display || []) {
    const i = idx(d.position);
    const v = angles?.[d.angle];
    if (i == null || v == null) continue;
    const [x, y] = P(i);
    const text = `${Math.round(v)}°`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x + 10 * dpr, y - 11 * dpr, tw + 10 * dpr, 22 * dpr);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x + 15 * dpr, y);
  }
}
