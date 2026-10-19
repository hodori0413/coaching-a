// 운동 판정 엔진 — 원본 exercises/base_exercise.py + engine.py 를 JS로 옮기고 버그를 고친 버전
//
// 원본 대비 바뀐 점
//  [버그] 각도 스무딩이 모든 각도를 한 기록에 섞음 → 각도별로 따로 평균
//  [버그] bilateral 운동에 left/right 각도 정의가 없으면 각도가 비어 횟수가 안 셈
//         (bicep_curl, high_knees, mountain_climber) → primary 정의를 좌우로 복제
//  [버그] duration 운동의 유지 상태 이름이 YAML과 안 맞으면 타이머가 안 돎 (wall_sit)
//         → hold_state가 없으면 state_order 첫 번째 상태를 유지 상태로 사용
//  [버그] bilateral 운동은 피드백 조건의 'angle' 변수가 없어 경고가 안 뜸 → 좌우 각각 평가
//  [개선] 폼 점수: 매 프레임 계산 → 한 회(rep)가 끝날 때 그 회 전체를 평가
//  [개선] 경고는 일정 시간(debounce_ms) 이상 이어질 때만 표시 (한 프레임 튀는 값 무시)
//  [버그] from_state에서 trigger로 '바로' 넘어갈 때만 세서 중간 상태가 있는 운동은 절대 안 셈
//         (deadlift, tricep_dip) → 이번 회에 from_state를 거쳤으면 셈
//  [개선] 휴식 자세로 돌아온 뒤에만 다음 회를 셈 (바닥 근처에서 두 번 세지는 문제 방지)
//  [추가] YAML 피드백 규칙에 check: rep_end (한 회가 끝났을 때 평가), view, states 필터
//  좌표 정규화·측면 방향 처리는 body.js 참고

import { compileSafe } from "./condition.js";
import { BodyNormalizer, REF_TORSO, angleAt, mirrorName, ALL_NAMES } from "./body.js";

const SEVERITY_PENALTY = { error: 10, warning: 10, info: 5, success: 0 };
const MIN_VISIBILITY = 0.5;

export function gradeOf(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function normalizeConfig(cfg) {
  if (!cfg || !cfg.name) throw new Error("운동 정의에 name이 없습니다");
  const angles = {};
  for (const [k, v] of Object.entries(cfg.angles || {})) {
    if (!v.points || v.points.length !== 3) throw new Error(`각도 ${k}: points는 3개여야 합니다`);
    for (const p of v.points) if (!ALL_NAMES.includes(p)) throw new Error(`각도 ${k}: 알 수 없는 관절 ${p}`);
    angles[k] = v.points;
  }
  const bilateral = !!cfg.bilateral;
  if (bilateral) {
    // [버그 수정] left/right 정의가 없으면 primary(또는 left)를 거울 복제
    const base = angles.left || angles.primary;
    if (!base) throw new Error("bilateral 운동은 left 또는 primary 각도가 필요합니다");
    if (!angles.left) angles.left = base;
    if (!angles.right) angles.right = angles.left.map(mirrorName);
  }

  const stateOrder = cfg.state_order || Object.keys(cfg.states || {});
  const states = {};
  for (const s of stateOrder) {
    const def = (cfg.states || {})[s];
    if (!def) throw new Error(`state_order의 ${s}가 states에 없습니다`);
    states[s] = compileSafe(def.condition ?? "False");
  }

  const type = cfg.type === "duration" ? "duration" : "repetition";
  const feedback = Object.entries(cfg.feedback || {}).map(([name, f]) => ({
    name,
    message: f.message || "자세를 확인하세요",
    severity: f.severity || "warning",
    check: f.check === "rep_end" ? "rep_end" : "live",
    states: f.states || null,
    view: f.view || null,
    debounceMs: f.debounce_ms ?? 250,
    test: compileSafe(f.condition ?? "False"),
  }));

  const view = cfg.view || "any";
  return {
    raw: cfg,
    name: cfg.name,
    displayName: cfg.display_name || cfg.name.replace(/_/g, " "),
    type,
    bilateral,
    view,
    autoSide: cfg.auto_side ?? view !== "front",
    angles,
    angleNames: Object.keys(angles),
    stateOrder,
    states,
    trigger: cfg.counter?.trigger_state ?? null,
    fromState: cfg.counter?.from_state ?? null,
    restState: cfg.rest_state || stateOrder[stateOrder.length - 1],
    minRepMs: (cfg.min_rep_duration ?? 0.5) * 1000,
    smoothWindow: cfg.smoothing?.enabled ? cfg.smoothing.window ?? 5 : 1,
    feedback,
    idealAngles: cfg.form_score?.ideal_angles || null,
    tempo: cfg.form_score?.tempo_range || null,
    holdState: cfg.hold_state && states[cfg.hold_state] ? cfg.hold_state : stateOrder[0],
    targetSec: cfg.target_duration ?? 30,
    requiredPoints: [...new Set(Object.values(angles).flat())],
    visualization: cfg.visualization || {},
  };
}

function newChannel(side) {
  return { side, state: null, prev: null, armed: true, visitedFrom: false, lastCountMs: -Infinity, counter: 0, rep: null, fbSince: {} };
}

export class Exercise {
  constructor(config) {
    this.cfg = normalizeConfig(config);
    this.body = new BodyNormalizer({ autoSide: this.cfg.autoSide });
    this.reset();
  }

  reset() {
    const c = this.cfg;
    this.body.reset();
    this.history = Object.fromEntries(c.angleNames.map((n) => [n, []]));
    this.channels = c.bilateral ? [newChannel("L"), newChannel("R")] : [newChannel(null)];
    this.repLog = [];
    this.lastScore = null;
    // duration
    this.holding = false;
    this.holdStartMs = 0;
    this.holdSec = 0;
    this.bestHoldSec = 0;
    this.targetReached = false;
    this.holdCount = 0;
  }

  get counter() {
    return this.cfg.type === "duration" ? this.holdCount : this.channels.reduce((s, ch) => s + ch.counter, 0);
  }

  get avgScore() {
    const scored = this.repLog.filter((r) => r.score != null);
    if (!scored.length) return null;
    return Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length);
  }

  /**
   * 한 프레임 처리
   * @param lms MediaPipe pose landmarks (33개)
   * @param tMs 타임스탬프(ms) — 실시간은 performance.now(), 영상은 currentTime*1000
   * @param W,H 영상 해상도
   */
  update(lms, tMs, W, H) {
    const c = this.cfg;
    const result = { tracking: false, counted: false, feedback: [], repDone: null };

    if (!lms || lms.length < 33) {
      result.message = "사람이 보이지 않아요";
      return this._finish(result);
    }
    const frame = this.body.process(lms, W, H);
    result.view = frame.view;
    result.pointIndex = frame.index;
    if (c.view !== "any" && frame.view && frame.view !== c.view) {
      result.viewWarning = c.view === "side" ? "옆으로 서서 찍어주세요" : "카메라 정면을 봐주세요";
    }

    const vis = c.requiredPoints.reduce((s, n) => s + frame.points[n].v, 0) / c.requiredPoints.length;
    if (vis < MIN_VISIBILITY) {
      result.message = "몸 전체가 화면에 들어오게 해주세요";
      return this._finish(result);
    }
    result.tracking = true;

    // 각도 (각도별 이동평균 — 원본 버그 수정)
    const angles = {};
    for (const n of c.angleNames) {
      const [a, b, d] = c.angles[n].map((p) => frame.points[p]);
      const h = this.history[n];
      h.push(angleAt(a, b, d));
      if (h.length > c.smoothWindow) h.shift();
      angles[n] = h.reduce((s, x) => s + x, 0) / h.length;
    }
    result.angles = angles;

    // 조건식에서 쓸 변수
    const ctx = { torso: REF_TORSO, is_side: frame.view === "side", is_front: frame.view === "front" };
    for (const [n, v] of Object.entries(angles)) ctx[`${n}_angle`] = v;
    if (angles.primary != null) ctx.angle = angles.primary;
    for (const n of ALL_NAMES) {
      ctx[`${n}_x`] = frame.points[n].x;
      ctx[`${n}_y`] = frame.points[n].y;
    }
    Object.assign(ctx, frame.derived);
    result.derived = frame.derived;

    if (c.type === "duration") this._updateDuration(ctx, tMs, frame.view, result);
    else for (const ch of this.channels) this._updateChannel(ch, ctx, angles, tMs, frame.view, result);

    return this._finish(result);
  }

  _channelCtx(ch, ctx) {
    if (!ch.side) return ctx;
    const side = ch.side === "L" ? "left" : "right";
    return { ...ctx, angle: ctx[`${side}_angle`], counter_left: this.channels[0].counter, counter_right: this.channels[1].counter };
  }

  _fsm(ch, ctx) {
    ch.prev = ch.state;
    for (const s of this.cfg.stateOrder) {
      if (this.cfg.states[s](ctx)) { ch.state = s; break; }
    }
  }

  _liveFeedback(ch, ctx, tMs, view, result) {
    const active = [];
    for (const f of this.cfg.feedback) {
      if (f.check !== "live") continue;
      if (f.view && f.view !== view) { delete ch.fbSince[f.name]; continue; }
      if (f.states && !f.states.includes(ch.state)) { delete ch.fbSince[f.name]; continue; }
      if (f.test(ctx)) {
        ch.fbSince[f.name] ??= tMs;
        if (tMs - ch.fbSince[f.name] >= f.debounceMs) active.push(f);
      } else {
        delete ch.fbSince[f.name];
      }
    }
    for (const f of active) result.feedback.push({ name: f.name, message: f.message, severity: f.severity, side: ch.side });
    return active;
  }

  _updateChannel(ch, baseCtx, angles, tMs, view, result) {
    const c = this.cfg;
    const ctx = this._channelCtx(ch, baseCtx);
    this._fsm(ch, ctx);
    const changed = ch.prev !== ch.state;
    if (ch.state) result[ch.side === "R" ? "stateRight" : ch.side === "L" ? "stateLeft" : "state"] = ch.state;

    // 다시 셀 준비: 휴식 자세로 돌아왔는지 / from_state를 거쳤는지
    if (c.restState !== c.trigger && ch.state === c.restState) ch.armed = true;
    if (c.restState === c.trigger && ch.state !== c.trigger) ch.armed = true;
    if (ch.state === c.fromState) ch.visitedFrom = true;

    // 한 회 시작
    if (changed && ch.prev === c.restState && ch.state !== c.restState && !ch.rep) {
      ch.rep = { t0: tMs, min: {}, max: {}, faults: new Map(), counted: false, atTrigger: null };
    }
    const rep = ch.rep;
    if (rep) {
      const a = this._sideAngles(ch, angles);
      for (const [n, v] of Object.entries(a)) {
        rep.min[n] = Math.min(rep.min[n] ?? Infinity, v);
        rep.max[n] = Math.max(rep.max[n] ?? -Infinity, v);
      }
    }

    // 횟수 (원본 규칙 + 휴식 자세 복귀 조건)
    // [버그 수정] 원본은 from_state에서 '바로' trigger로 넘어갈 때만 셈 → deadlift(down→hinge→up),
    // tricep_dip(down→lower→up)은 중간 상태 때문에 절대 안 셈. 여기서는 '이번 회에 from_state를 거쳤으면' 셈
    if (changed && ch.state === c.trigger && (!c.fromState || ch.visitedFrom)
        && ch.armed && tMs - ch.lastCountMs >= c.minRepMs) {
      ch.counter += 1;
      ch.lastCountMs = tMs;
      ch.armed = false;
      ch.visitedFrom = false;
      result.counted = true;
      if (rep) { rep.counted = true; rep.atTrigger = this._sideAngles(ch, angles); }
    }

    // 실시간 피드백
    const active = this._liveFeedback(ch, ctx, tMs, view, result);
    if (rep) for (const f of active) if (f.severity !== "success") rep.faults.set(f.name, f);

    // 한 회 끝 (휴식 자세 복귀)
    if (rep && changed && ch.state === c.restState) {
      ch.rep = null;
      const done = this._finishRep(ch, rep, ctx, tMs, view);
      if (done) result.repDone = done;
    }
  }

  _sideAngles(ch, angles) {
    if (!ch.side) return angles;
    const own = ch.side === "L" ? "left" : "right";
    const out = { ...angles };
    if (angles[own] != null) out.primary = angles[own];
    return out;
  }

  _finishRep(ch, rep, ctx, tMs, view) {
    const c = this.cfg;
    const durSec = (tMs - rep.t0) / 1000;

    // rep_end 규칙: 이번 회의 최소/최대 각도로 평가
    const repCtx = { ...ctx, rep_counted: rep.counted, rep_duration: durSec };
    for (const [n, v] of Object.entries(rep.min)) {
      repCtx[`rep_min_${n}_angle`] = v;
      repCtx[`rep_max_${n}_angle`] = rep.max[n];
      if (n === "primary") { repCtx.rep_min_angle = v; repCtx.rep_max_angle = rep.max[n]; }
    }
    for (const f of c.feedback) {
      if (f.check !== "rep_end" || (f.view && f.view !== view)) continue;
      if (f.test(repCtx) && f.severity !== "success") rep.faults.set(f.name, f);
    }

    if (!rep.counted && (rep.faults.size === 0 || durSec < 0.3)) return null; // 흔들림 정도는 무시

    let score = null;
    if (rep.counted) {
      score = 100;
      // 각도 정확도 (원본: 10° 벗어날 때마다 5점, 최대 40점) — 횟수가 세진 순간의 각도 기준
      if (c.idealAngles) {
        const devs = Object.entries(c.idealAngles)
          .filter(([n]) => rep.atTrigger?.[n] != null)
          .map(([n, ideal]) => (Math.abs(rep.atTrigger[n] - ideal) / 10) * 5);
        if (devs.length) score -= Math.min(devs.reduce((s, x) => s + x, 0) / devs.length, 40);
      }
      // 속도 (원본: 너무 빠르면 0.5초당 15점, 너무 느리면 1초당 10점, 최대 30점)
      if (c.tempo) {
        let t = 0;
        if (durSec < c.tempo.min) t = ((c.tempo.min - durSec) / 0.5) * 15;
        else if (durSec > c.tempo.max) t = (durSec - c.tempo.max) * 10;
        score -= Math.min(t, 30);
      }
      // 자세 오류 (최대 30점)
      const fb = [...rep.faults.values()].reduce((s, f) => s + (SEVERITY_PENALTY[f.severity] ?? 10), 0);
      score -= Math.min(fb, 30);
      score = Math.max(0, Math.round(score));
      this.lastScore = score;
    }

    const entry = {
      n: rep.counted ? this.counter : null,
      side: ch.side,
      counted: rep.counted,
      durationSec: Math.round(durSec * 100) / 100,
      score,
      grade: score == null ? null : gradeOf(score),
      faults: [...rep.faults.values()].map((f) => ({ name: f.name, message: f.message, severity: f.severity })),
      minAngles: rep.min,
      maxAngles: rep.max,
    };
    this.repLog.push(entry);
    return entry;
  }

  _updateDuration(ctx, tMs, view, result) {
    const c = this.cfg;
    const ch = this.channels[0];
    this._fsm(ch, ctx);
    if (ch.state) result.state = ch.state;

    if (ch.state === c.holdState) {
      if (!this.holding) { this.holding = true; this.holdStartMs = tMs; this.targetReached = false; }
      this.holdSec = (tMs - this.holdStartMs) / 1000;
      this.bestHoldSec = Math.max(this.bestHoldSec, this.holdSec);
      if (!this.targetReached && this.holdSec >= c.targetSec) {
        this.targetReached = true;
        this.holdCount += 1;
        result.counted = true;
      }
    } else if (this.holding) {
      this.repLog.push({ n: this.holdCount, holdSec: Math.round(this.holdSec * 10) / 10, reached: this.targetReached });
      this.holding = false;
      this.holdSec = 0;
    }
    this._liveFeedback(ch, ctx, tMs, view, result);
  }

  _finish(result) {
    const c = this.cfg;
    result.counter = this.counter;
    if (c.bilateral) {
      result.counterLeft = this.channels[0].counter;
      result.counterRight = this.channels[1].counter;
    }
    if (c.type === "duration") {
      result.holdSec = this.holdSec;
      result.bestHoldSec = this.bestHoldSec;
      result.targetSec = c.targetSec;
      result.isHolding = this.holding;
    }
    result.lastScore = this.lastScore;
    result.lastGrade = this.lastScore == null ? null : gradeOf(this.lastScore);
    result.avgScore = this.avgScore;
    return result;
  }
}
