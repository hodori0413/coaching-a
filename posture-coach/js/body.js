// MediaPipe 33개 관절 → 판정용 좌표로 정리
//
// 원본 레포 문제: 픽셀 좌표(1280x720)를 그대로 써서, 폰과의 거리·해상도에 따라 판정이 달라짐.
// 여기서는 몸통 길이(어깨 중앙~골반 중앙)가 항상 REF_TORSO 단위가 되도록 좌표를 맞춘다.
// → YAML의 "50" 같은 숫자는 '몸통 길이의 50/200 = 1/4' 이라는 일정한 의미가 된다.
//
// 측면 촬영일 때:
//  - 카메라에 더 잘 보이는 쪽 몸을 'left_*' 이름으로 쓴다 (원본은 항상 왼쪽만 써서
//    오른쪽이 카메라를 향하면 가려진 관절로 판정했음)
//  - 사람이 바라보는 방향이 항상 +x 가 되도록 좌우를 뒤집는다
//    (예: "left_shoulder_x > left_hip_x + 50" = 상체가 앞으로 숙여짐 — 어느 쪽을 보고 서든 같은 뜻)

export const LANDMARKS = {
  nose: 0, left_eye_inner: 1, left_eye: 2, left_eye_outer: 3,
  right_eye_inner: 4, right_eye: 5, right_eye_outer: 6,
  left_ear: 7, right_ear: 8, mouth_left: 9, mouth_right: 10,
  left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14,
  left_wrist: 15, right_wrist: 16, left_pinky: 17, right_pinky: 18,
  left_index: 19, right_index: 20, left_thumb: 21, right_thumb: 22,
  left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28, left_heel: 29, right_heel: 30,
  left_foot_index: 31, right_foot_index: 32,
};
export const NAMES = Object.keys(LANDMARKS);

// 몸통 길이를 이 값으로 맞춘다. 1280x720 화면에 몸 전체가 꽉 차게 찍혔을 때의 몸통 길이와 비슷한 크기라
// 원본 YAML의 픽셀 기준값을 크게 바꾸지 않고 쓸 수 있다.
export const REF_TORSO = 200;

const SIDE_POINTS = ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"];

export function mirrorName(name) {
  if (name.startsWith("left_")) return "right_" + name.slice(5);
  if (name.startsWith("right_")) return "left_" + name.slice(6);
  return name;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class BodyNormalizer {
  constructor({ autoSide = true } = {}) {
    this.autoSide = autoSide;
    this.reset();
  }

  reset() {
    this.torsoEst = null;
    this.view = null;      // 'side' | 'front'
    this.swapped = false;  // 측면에서 오른쪽이 더 잘 보여 좌우 이름을 바꿨는지
    this.facing = 1;       // 측면에서 바라보는 방향 (+1: 화면 오른쪽)
    this.facingEma = 0;
  }

  /**
   * @param lms MediaPipe landmarks [{x,y,z,visibility}] (0~1 정규화 좌표)
   * @param W,H 영상 해상도
   */
  process(lms, W, H) {
    const px = lms.map((l) => ({ x: l.x * W, y: l.y * H, v: l.visibility ?? 1 }));
    const P = (n) => px[LANDMARKS[n]];

    // 1) 몸통 길이 (커질 때는 빨리, 작아질 때는 천천히 따라감 — 앞으로 숙여 짧아 보이는 순간에 흔들리지 않게)
    const torso = dist(mid(P("left_shoulder"), P("right_shoulder")), mid(P("left_hip"), P("right_hip")));
    if (torso > 1) {
      if (this.torsoEst == null) this.torsoEst = torso;
      else if (torso > this.torsoEst) this.torsoEst = 0.7 * this.torsoEst + 0.3 * torso;
      else this.torsoEst = 0.98 * this.torsoEst + 0.02 * torso;
    }
    const scale = this.torsoEst ? REF_TORSO / this.torsoEst : 1;

    // 2) 정면/측면 판단: 어깨·골반 폭 ÷ 몸통 길이
    const width = Math.max(
      Math.abs(P("left_shoulder").x - P("right_shoulder").x),
      Math.abs(P("left_hip").x - P("right_hip").x),
    );
    const ratio = width / Math.max(this.torsoEst || torso || 1, 1);
    if (ratio > 0.5) this.view = "front";
    else if (ratio < 0.3) this.view = "side";
    else if (!this.view) this.view = ratio >= 0.4 ? "front" : "side";

    // 3) 측면이면 더 잘 보이는 쪽을 'left'로
    if (this.view === "side" && this.autoSide) {
      const avg = (side) => SIDE_POINTS.reduce((s, p) => s + P(`${side}_${p}`).v, 0) / SIDE_POINTS.length;
      const vl = avg("left"), vr = avg("right");
      if (!this.swapped && vr > vl + 0.15) this.swapped = true;
      else if (this.swapped && vl > vr + 0.15) this.swapped = false;
    } else if (this.view === "front") {
      this.swapped = false;
    }

    // 4) 측면이면 바라보는 방향 (코가 귀보다 앞)
    if (this.view === "side") {
      const ear = this.swapped ? P("right_ear") : P("left_ear");
      const dx = (P("nose").x - ear.x) / Math.max(this.torsoEst || 1, 1);
      this.facingEma = 0.8 * this.facingEma + 0.2 * dx;
      if (Math.abs(this.facingEma) > 0.03) this.facing = this.facingEma > 0 ? 1 : -1;
    }
    const flip = this.view === "side" ? this.facing : 1;

    // 5) 이름 → 좌표/가시성
    const index = {};
    const points = {};
    for (const name of NAMES) {
      const src = this.swapped ? mirrorName(name) : name;
      const i = LANDMARKS[src];
      index[name] = i;
      points[name] = { x: px[i].x * scale * flip, y: px[i].y * scale, v: px[i].v };
    }

    // 6) 앞다리/뒷다리 (측면 촬영 런지 등): 발목이 더 앞(+x)에 있는 다리를 front_*
    //    정면 촬영에서는 앞뒤를 알 수 없으므로 왼쪽을 front로 둔다
    const leftFront = this.view !== "side" || points.left_ankle.x >= points.right_ankle.x;
    for (const part of LEG_PARTS) {
      const f = leftFront ? `left_${part}` : `right_${part}`;
      const b = leftFront ? `right_${part}` : `left_${part}`;
      points[`front_${part}`] = points[f]; index[`front_${part}`] = index[f];
      points[`back_${part}`] = points[b]; index[`back_${part}`] = index[b];
    }

    // 7) 자주 쓰는 파생값
    const S = points.left_shoulder, Hp = points.left_hip, A = points.left_ankle;
    // 체간 기울기(°): 측면에서 +면 앞으로 숙임, -면 뒤로 젖힘. 정면에서는 좌우 기울기
    const trunkLean = (Math.atan2(S.x - Hp.x, Hp.y - S.y) * 180) / Math.PI;
    // 엉덩이가 어깨-발목 선보다 얼마나 아래(+)/위(-)에 있는지 (플랭크·푸시업)
    const dx = A.x - S.x;
    // 몸이 누워 있을 때(어깨-발목이 가로로 몸통 길이 이상 떨어짐)만 의미 있음, 서 있으면 0
    const hipLineOffset = Math.abs(dx) > REF_TORSO ? Hp.y - (S.y + ((A.y - S.y) * (Hp.x - S.x)) / dx) : 0;

    return {
      points, index, view: this.view, swapped: this.swapped, facing: this.facing, scale, torsoPx: this.torsoEst,
      derived: { trunk_lean: trunkLean, hip_line_offset: hipLineOffset },
    };
  }
}

const LEG_PARTS = ["hip", "knee", "ankle", "heel", "foot_index"];
export const VIRTUAL_NAMES = LEG_PARTS.flatMap((p) => [`front_${p}`, `back_${p}`]);
export const ALL_NAMES = [...NAMES, ...VIRTUAL_NAMES];

export function angleAt(a, b, c) {
  const bax = a.x - b.x, bay = a.y - b.y;
  const bcx = c.x - b.x, bcy = c.y - b.y;
  const cos = (bax * bcx + bay * bcy) / (Math.hypot(bax, bay) * Math.hypot(bcx, bcy) + 1e-6);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
