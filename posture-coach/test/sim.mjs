// 테스트용 가짜 사람 — 관절 각도를 넣으면 MediaPipe와 같은 형식의 33개 랜드마크를 만든다
// side: 옆모습(x=앞, y=위), front: 정면(x=사람의 왼쪽, y=위)

const L = { torso: 0.5, thigh: 0.45, shank: 0.43, upper: 0.3, fore: 0.27, ankleH: 0.07 };
const rad = (d) => (d * Math.PI) / 180;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const down = (deg, len) => ({ x: Math.sin(rad(deg)) * len, y: -Math.cos(rad(deg)) * len }); // 0°=아래, +=앞
const up = (deg, len) => ({ x: Math.sin(rad(deg)) * len, y: Math.cos(rad(deg)) * len });     // 0°=위, +=앞

function sideLeg(hip, p) {
  const knee = add(hip, down(p.hip ?? 0, L.thigh));
  const ankle = add(knee, down((p.hip ?? 0) - (p.knee ?? 0), L.shank));
  const heel = add(ankle, { x: -0.05, y: -0.06 });
  const toe = add(ankle, { x: 0.15, y: -0.07 });
  return { knee, ankle, heel, toe };
}

/**
 * 옆모습 자세
 * p: { trunk, L:{hip,knee}, R:{hip,knee}, armL:{sh,el}, armR:{sh,el}, heelRise, lying(0|90) }
 */
export function sidePose(p = {}) {
  const lg = p.L || {}, rg = p.R || lg;
  const hipH = L.thigh + L.shank + L.ankleH;
  const hip = { x: 0, y: hipH };
  const legs = { left: sideLeg(hip, lg), right: sideLeg(hip, rg) };
  // 가장 낮은 발이 바닥(y=0.0)에 닿게
  const minY = Math.min(legs.left.toe.y, legs.right.toe.y, legs.left.heel.y, legs.right.heel.y);
  const sh = add(hip, up(p.trunk ?? 0, L.torso));
  const arm = (a = {}) => {
    const el = add(sh, down(a.sh ?? 0, L.upper));
    const wr = add(el, down((a.sh ?? 0) + (a.el ?? 0), L.fore));
    return { el, wr };
  };
  const arms = { left: arm(p.armL || p.arm), right: arm(p.armR || p.arm) };
  const headUp = up(p.trunk ?? 0, 0.22);
  const ear = add(sh, headUp);
  const nose = add(ear, up((p.trunk ?? 0) + 90, 0.08)); // 귀보다 앞
  const pts = { hip, sh, ear, nose, legs, arms };

  // 정리 + 회전(누운 자세) + 바닥 맞추기
  const rot = rad(p.lying ?? 0); // +90: 머리가 앞(+x)쪽으로 눕기
  const R = (q) => ({ x: q.x * Math.cos(rot) + q.y * Math.sin(rot), y: -q.x * Math.sin(rot) + q.y * Math.cos(rot) });
  const flat = {};
  const put = (name, q) => { flat[name] = R(q); };
  put("nose", nose); put("ear", ear); put("shoulder", sh); put("hip", hip);
  for (const s of ["left", "right"]) {
    put(`${s}_knee`, legs[s].knee); put(`${s}_ankle`, legs[s].ankle);
    put(`${s}_heel`, legs[s].heel); put(`${s}_toe`, legs[s].toe);
    put(`${s}_elbow`, arms[s].el); put(`${s}_wrist`, arms[s].wr);
  }
  let floor = Math.min(...Object.values(flat).map((q) => q.y));
  if (p.lying) floor = Math.min(flat.left_toe.y, flat.left_wrist.y, flat.hip.y - 0.3);
  for (const k in flat) flat[k].y -= floor;
  if (p.heelRise) {
    for (const k in flat) if (!k.endsWith("_toe")) flat[k].y += p.heelRise;
  }
  return { view: "side", flat };
}

/** 정면 자세. p: { squat:{hip,knee}, caveL, caveR, armL:{abd, el}, armR, legL:{abd}, legR } */
export function frontPose(p = {}) {
  const flat = {};
  const hipH = L.thigh + L.shank + L.ankleH;
  const drop = p.drop ?? 0; // 쪼그려 앉으면 엉덩이 높이가 내려감(정면에서는 높이 변화만 보임)
  const hy = hipH - drop;
  flat.hip_l = { x: 0.12, y: hy }; flat.hip_r = { x: -0.12, y: hy };
  flat.sh_l = { x: 0.2, y: hy + L.torso }; flat.sh_r = { x: -0.2, y: hy + L.torso };
  flat.nose = { x: 0, y: hy + L.torso + 0.2 };
  flat.ear_l = { x: 0.07, y: hy + L.torso + 0.22 }; flat.ear_r = { x: -0.07, y: hy + L.torso + 0.22 };
  for (const [s, sg] of [["l", 1], ["r", -1]]) {
    const leg = (s === "l" ? p.legL : p.legR) || {};
    const abd = leg.abd ?? 0;
    const cave = (s === "l" ? p.caveL : p.caveR) ?? 0;
    const hip = flat[`hip_${s}`];
    const ankle = { x: hip.x + sg * Math.sin(rad(abd)) * (L.thigh + L.shank) + sg * 0.03, y: L.ankleH };
    const knee = { x: (hip.x + ankle.x) / 2 - sg * cave, y: (hip.y + ankle.y) / 2 };
    flat[`knee_${s}`] = knee; flat[`ankle_${s}`] = ankle;
    flat[`heel_${s}`] = { x: ankle.x, y: 0.01 }; flat[`toe_${s}`] = { x: ankle.x + sg * 0.03, y: 0 };
    const arm = (s === "l" ? p.armL : p.armR) || p.arm || {};
    const sh = flat[`sh_${s}`];
    const a = rad(arm.abd ?? 0);
    const el = { x: sh.x + sg * Math.sin(a) * L.upper, y: sh.y - Math.cos(a) * L.upper };
    const fa = a + rad(arm.el ?? 0) * (arm.elDir ?? 1);
    const wr = { x: el.x + sg * Math.sin(fa) * L.fore, y: el.y - Math.cos(fa) * L.fore };
    flat[`elbow_${s}`] = el; flat[`wrist_${s}`] = wr;
  }
  return { view: "front", flat };
}

/**
 * 33개 랜드마크로 변환
 * opt: { W, H, scale(화면 높이 대비 사람 크기), cx, cy, facing(측면 +1/-1), near('left'|'right'), farVis }
 */
export function toLandmarks(pose, opt = {}) {
  const W = opt.W ?? 720, H = opt.H ?? 1280;
  const s = (opt.scale ?? 0.6) * H / 1.75;     // 키 1.75 단위 → 화면 비율
  const cx = opt.cx ?? W / 2, base = opt.base ?? H * 0.92;
  const facing = opt.facing ?? 1;
  const near = opt.near ?? "left";
  const farVis = opt.farVis ?? 0.5;
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const set = (i, q, vis = 0.95) => {
    lm[i] = { x: (cx + q.x * s) / W, y: (base - q.y * s) / H, z: 0, visibility: vis };
  };
  const f = pose.flat;
  if (pose.view === "side") {
    const X = (q) => ({ x: q.x * facing, y: q.y });
    const vis = (side) => (side === near ? 0.95 : farVis);
    set(0, X(f.nose));
    for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) set(i, X(f.nose), 0.9);
    // 측면: 좌우 몸이 거의 겹침 (아주 약간의 깊이 차이만)
    for (const side of ["left", "right"]) {
      const o = side === "left" ? 0 : 1;
      const tiny = (q) => X({ x: q.x + (side === near ? 0 : 0.01), y: q.y });
      set(7 + o, tiny(f.ear), vis(side));
      set(11 + o, tiny(f.shoulder), vis(side));
      set(13 + o, tiny(f[`${side}_elbow`]), vis(side));
      set(15 + o, tiny(f[`${side}_wrist`]), vis(side));
      for (const i of [17, 19, 21]) set(i + o, tiny(f[`${side}_wrist`]), vis(side));
      set(23 + o, tiny(f.hip), vis(side));
      set(25 + o, tiny(f[`${side}_knee`]), vis(side));
      set(27 + o, tiny(f[`${side}_ankle`]), vis(side));
      set(29 + o, tiny(f[`${side}_heel`]), vis(side));
      set(31 + o, tiny(f[`${side}_toe`]), vis(side));
    }
  } else {
    // 정면(카메라 원본, 좌우반전 없음): 사람의 왼쪽이 화면 오른쪽(+x)
    set(0, f.nose);
    for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) set(i, f.nose, 0.9);
    const m = { l: 0, r: 1 };
    for (const [s, o] of Object.entries(m)) {
      set(7 + o, f[`ear_${s}`]); set(11 + o, f[`sh_${s}`]); set(13 + o, f[`elbow_${s}`]);
      set(15 + o, f[`wrist_${s}`]);
      for (const i of [17, 19, 21]) set(i + o, f[`wrist_${s}`]);
      set(23 + o, f[`hip_${s}`]); set(25 + o, f[`knee_${s}`]); set(27 + o, f[`ankle_${s}`]);
      set(29 + o, f[`heel_${s}`]); set(31 + o, f[`toe_${s}`]);
    }
  }
  return { lm, W, H };
}

// 0→1→0 한 번 왕복
export const cycle = (t) => (1 - Math.cos(2 * Math.PI * t)) / 2;
export const lerp = (a, b, k) => a + (b - a) * k;
