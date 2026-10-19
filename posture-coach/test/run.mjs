// 엔진 테스트: node test/run.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "../js/vendor/js-yaml.mjs";
import { Exercise } from "../js/engine.js";
import { compile } from "../js/condition.js";
import { sidePose, frontPose, toLandmarks, cycle } from "./sim.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (name) => new Exercise(yaml.load(readFileSync(join(root, "exercises", `${name}.yaml`), "utf8")));
const manifest = JSON.parse(readFileSync(join(root, "exercises", "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

/** segments: [{sec, pose:(k 0..1, t)=>pose}] 를 30fps로 재생 */
function play(ex, segments, opt = {}) {
  const fps = 30;
  let tMs = 0;
  const seen = new Map();
  let last;
  for (const seg of segments) {
    const n = Math.round(seg.sec * fps);
    for (let i = 0; i < n; i++) {
      const k = n > 1 ? i / (n - 1) : 0;
      const { lm, W, H } = toLandmarks(seg.pose(k), { ...opt, ...(seg.opt || {}) });
      last = ex.update(lm, tMs, W, H);
      for (const f of last.feedback) seen.set(f.name, (seen.get(f.name) || 0) + 1);
      tMs += 1000 / fps;
    }
  }
  const repFaults = new Set(ex.repLog.flatMap((r) => (r.faults || []).map((f) => f.name)));
  return { last, seen, repFaults, log: ex.repLog };
}
const stand = (sec, pose) => ({ sec, pose: () => pose });

// ---------- 조건식 파서 ----------
console.log("조건식 파서");
{
  const ctx = { angle: 120, a: 3, left_hip_y: 10, right_hip_y: 45 };
  check("and/비교", compile("angle > 90 and angle <= 165")(ctx) === true);
  check("abs()", compile("abs(left_hip_y - right_hip_y) > 30")(ctx) === true);
  check("연쇄 비교", compile("90 < angle < 130")(ctx) === true && compile("90 < angle < 100")(ctx) === false);
  check("not / or / 괄호", compile("not (angle < 100 or a == 4)")(ctx) === true);
  check("산술 우선순위", compile("a + 2 * 3 == 9")(ctx) === true);
  let threw = false; try { compile("__import__('os')"); } catch { threw = true; }
  let threw2 = false; try { compile("open(1)")({}); } catch { threw2 = true; }
  check("위험한 식 거부", threw && threw2);
}

// ---------- 18개 모두 로드 ----------
console.log("운동 정의 로드");
for (const n of manifest) {
  let ok = true, err = "";
  try { load(n); } catch (e) { ok = false; err = e.message; }
  check(`${n} 로드`, ok, err);
}

// ---------- 스쿼트 ----------
const squatPose = (k, depth = 1, lean = 40) => sidePose({ trunk: lean * k * depth, L: { hip: 95 * k * depth, knee: 120 * k * depth } });
function squatRun(opt) {
  const ex = load("squat");
  const S = sidePose({});
  const segs = [stand(1, S)];
  for (let i = 0; i < 3; i++) segs.push({ sec: 2, pose: (k) => squatPose(cycle(k)) }, stand(0.6, S));
  segs.push({ sec: 2, pose: (k) => squatPose(cycle(k), 0.45) }, stand(0.6, S));        // 얕게
  segs.push({ sec: 2, pose: (k) => squatPose(cycle(k), 1, 65) }, stand(0.6, S));       // 상체 과도
  return play(ex, segs, opt);
}
console.log("스쿼트 (측면, 오른쪽 보고 섬, 왼쪽이 카메라 쪽)");
{
  const r = squatRun({ facing: 1, near: "left", scale: 0.6 });
  check("4회 (깊은 3 + 상체과도 1) 셈, 얕은 회는 안 셈", r.last.counter === 4, `counter=${r.last.counter}`);
  check("얕은 회 → '더 깊이'", r.repFaults.has("not_deep_enough"));
  check("상체 과도 → leaning_forward", r.repFaults.has("leaning_forward"));
  const good = r.log.filter((x) => x.counted).slice(0, 3);
  check("정상 3회는 오류 없음", good.every((x) => x.faults.length === 0), JSON.stringify(good.map((x) => x.faults)));
  check("정상 회 점수 100", good.every((x) => x.score === 100), JSON.stringify(good.map((x) => x.score)));
  check("측면 인식", r.last.view === "side");
}
console.log("스쿼트 (왼쪽 보고 섬, 오른쪽이 카메라 쪽, 멀리서 작게)");
{
  const r = squatRun({ facing: -1, near: "right", scale: 0.3 });
  check("같은 결과: 4회", r.last.counter === 4, `counter=${r.last.counter}`);
  check("같은 결과: 상체 과도 감지", r.repFaults.has("leaning_forward"));
  check("같은 결과: 얕은 회 감지", r.repFaults.has("not_deep_enough"));
}
console.log("스쿼트 (정면 촬영: 무릎 모임)");
{
  const ex = load("squat");
  const segs = [stand(1, frontPose({}))];
  segs.push({ sec: 2, pose: (k) => frontPose({ drop: 0.3 * cycle(k), caveL: 0.12 * cycle(k), caveR: 0.12 * cycle(k) }) });
  const r = play(ex, segs, {});
  check("정면 인식", r.last.view === "front");
  check("측면 권장 경고 표시", r.last.viewWarning === "옆으로 서서 찍어주세요");
}

// ---------- 런지 ----------
console.log("런지 (앞다리 자동 선택)");
{
  const ex = load("lunge");
  const S = sidePose({});
  const lunge = (front, k) => {
    const f = { hip: 80 * k, knee: 90 * k }, b = { hip: -25 * k, knee: 100 * k };
    return sidePose({ trunk: 5 * k, L: front === "L" ? f : b, R: front === "L" ? b : f });
  };
  const r = play(ex, [stand(1, S), { sec: 2.4, pose: (k) => lunge("L", cycle(k)) }, stand(0.6, S),
    { sec: 2.4, pose: (k) => lunge("R", cycle(k)) }, stand(0.6, S)], { near: "left" });
  check("왼다리·오른다리 앞 각각 1회 = 2회", r.last.counter === 2, `counter=${r.last.counter}`);
  const a = r.log[0]?.minAngles || {};
  check("[원본 버그] 각도가 섞이지 않음 (앞무릎 90, 뒷무릎 80, 상체-앞허벅지 95)",
    Math.abs(a.primary - 90) < 3 && Math.abs(a.back_leg - 80) < 3 && Math.abs(a.torso - 95) < 3, JSON.stringify(a));
}

// ---------- 푸시업 ----------
console.log("푸시업");
{
  const ex = load("push_up");
  const P = (k, legs = 0) => sidePose({ lying: 90, L: { hip: legs }, arm: { sh: 90, el: 115 * k } });
  const r = play(ex, [stand(1, P(0)), { sec: 2, pose: (k) => P(cycle(k)) }, stand(0.5, P(0)),
    { sec: 2, pose: (k) => P(cycle(k)) }, stand(0.5, P(0)),
    { sec: 2, pose: (k) => P(cycle(k), -22) }, stand(0.5, P(0))], { scale: 0.45 });
  check("3회", r.last.counter === 3, `counter=${r.last.counter}`);
  check("정상 2회는 오류 없음", r.log.slice(0, 2).every((x) => x.faults.length === 0), JSON.stringify(r.log.slice(0, 2).map((x) => x.faults)));
  check("허리 처짐 감지", r.repFaults.has("hips_sagging"), JSON.stringify([...r.repFaults]));
}

// ---------- 플랭크 ----------
console.log("플랭크");
{
  const ex = load("plank");
  const P = (legs = 0) => sidePose({ lying: 90, L: { hip: legs }, arm: { sh: 90, el: 90 } });
  const r = play(ex, [stand(31, P(0)), stand(2, P(-22)), stand(2, P(22))], { scale: 0.45 });
  check("30초 유지 → 1회 달성", r.last.counter === 1, `counter=${r.last.counter}`);
  check("좋은 자세 메시지", r.seen.has("good_form"));
  check("허리 처짐 감지", r.seen.has("hips_sagging"), JSON.stringify([...r.seen.keys()]));
  check("엉덩이 들림 감지 (원본은 절대 안 걸림)", r.seen.has("hips_too_high"));
  check("자세 무너지면 타이머 멈춤", r.last.isHolding === false);
}

// ---------- 월싯 ----------
console.log("월싯");
{
  const ex = load("wall_sit");
  const r = play(ex, [stand(1, sidePose({})), stand(32, sidePose({ L: { hip: 90, knee: 90 } }))]);
  check("[원본 버그] 타이머 동작 → 30초 달성", r.last.counter === 1 && r.last.holdSec > 30, `counter=${r.last.counter} hold=${r.last.holdSec}`);
}

// ---------- 바이셉 컬 (좌우) ----------
console.log("바이셉 컬");
{
  const ex = load("bicep_curl");
  const F = (k) => frontPose({ arm: { abd: 5, el: 150 * k, elDir: -1 } });
  const segs = [stand(1, F(0))];
  for (let i = 0; i < 3; i++) segs.push({ sec: 2, pose: (k) => F(cycle(k)) }, stand(0.4, F(0)));
  segs.push({ sec: 2, pose: (k) => F(cycle(k) * 0.55) }, stand(0.4, F(0)));
  const r = play(ex, segs);
  check("[원본 버그] 횟수 셈: 왼쪽 3, 오른쪽 3", r.last.counterLeft === 3 && r.last.counterRight === 3, `L=${r.last.counterLeft} R=${r.last.counterRight}`);
  check("덜 올림 → partial_rep", r.repFaults.has("partial_rep"));
}

// ---------- 나머지 운동: 동작 한 사이클에 1회 이상 세는지 ----------
console.log("나머지 운동");
const simple = {
  deadlift: { bug: true, pose: (k) => sidePose({ trunk: 75 * k, L: { hip: 10 * k, knee: 15 * k } }) },
  glute_bridge: { pose: (k) => sidePose({ lying: -90, L: { hip: 70 * (1 - k), knee: 110 } }), rest: 0 },
  calf_raise: { pose: (k) => sidePose({ heelRise: 0.07 * k }) },
  tricep_dip: { bug: true, pose: (k) => sidePose({ arm: { sh: -20, el: 100 * k } }) },
  leg_raise: { pose: (k) => sidePose({ lying: -90, L: { hip: 85 * k } }), scale: 0.45 },
  side_lunge: { pose: (k) => frontPose({ drop: 0.35 * k, caveL: -0.35 * k, legL: { abd: 30 }, legR: { abd: 30 } }) },
  hammer_curl: { pose: (k) => frontPose({ arm: { abd: 5, el: 145 * k, elDir: -1 } }), expectMin: 2 },
  shoulder_press: { pose: (k) => frontPose({ arm: { abd: 75 + 100 * k, el: 0 } }) },
  lateral_raise: { pose: (k) => frontPose({ arm: { abd: 10 + 82 * k } }) },
  jumping_jack: { pose: (k) => frontPose({ arm: { abd: 10 + 165 * k }, legL: { abd: 15 * k }, legR: { abd: 15 * k } }) },
};
for (const [name, s] of Object.entries(simple)) {
  const ex = load(name);
  const segs = [stand(1, s.pose(s.rest ?? 0))];
  for (let i = 0; i < 2; i++) segs.push({ sec: 2, pose: (k) => s.pose(cycle(k)) }, stand(0.5, s.pose(0)));
  const r = play(ex, segs, { scale: s.scale ?? 0.6 });
  const want = s.expectMin ? 2 * s.expectMin : 2;
  check(`${s.bug ? "[원본 버그] " : ""}${name}: 2사이클 → ${want}회`, r.last.counter === want, `counter=${r.last.counter} feedback=${JSON.stringify([...r.seen.keys()])} faults=${JSON.stringify([...r.repFaults])}`);
}
{
  // 좌우 번갈아 하는 운동
  for (const [name, mk, scale] of [
    ["high_knees", (l, r) => sidePose({ L: { hip: 105 * l, knee: 90 * l }, R: { hip: 105 * r, knee: 90 * r } }), 0.6],
    ["mountain_climber", (l, r) => sidePose({ lying: 90, L: { hip: 100 * l, knee: 100 * l }, R: { hip: 100 * r, knee: 100 * r }, arm: { sh: 90 } }), 0.45],
  ]) {
    const ex = load(name);
    const segs = [stand(1, mk(0, 0))];
    for (let i = 0; i < 3; i++) segs.push({ sec: 0.8, pose: (k) => mk(cycle(k), 0) }, { sec: 0.8, pose: (k) => mk(0, cycle(k)) });
    segs.push(stand(0.5, mk(0, 0)));
    const r = play(ex, segs, { scale });
    check(`[원본 버그] ${name}: 좌우 각 3회`, r.last.counterLeft === 3 && r.last.counterRight === 3, `L=${r.last.counterLeft} R=${r.last.counterRight}`);
  }
}

// ---------- 안 보일 때 ----------
console.log("관절이 안 보일 때");
{
  const ex = load("squat");
  const { lm, W, H } = toLandmarks(sidePose({}), {});
  for (const p of lm) p.visibility = 0.1;
  const r = ex.update(lm, 0, W, H);
  check("판정 멈추고 안내", r.tracking === false && r.message);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
