// 앱 화면 연결: 운동 선택 → 카메라/영상 → 포즈 인식 → 엔진 → 화면/음성
import yaml from "./vendor/js-yaml.mjs";
import { Exercise } from "./engine.js";
import { PoseDetector, DemoDetector } from "./pose.js";
import { drawPose } from "./overlay.js";

const $ = (id) => document.getElementById(id);
const el = {
  exercise: $("exercise"), exInfo: $("exInfo"), btnCamera: $("btnCamera"), fileInput: $("fileInput"),
  btnStop: $("btnStop"), facing: $("facing"), model: $("model"), voice: $("voice"), debug: $("debug"),
  status: $("status"), video: $("video"), overlay: $("overlay"), count: $("count"), countSub: $("countSub"),
  scoreBox: $("scoreBox"), grade: $("grade"), score: $("score"), notice: $("notice"), messages: $("messages"),
  debugBox: $("debugBox"), summary: $("summary"), repLog: $("repLog"),
};

const DEMO = new URLSearchParams(location.search).has("demo");
const defs = {};          // name -> YAML 객체
let exercise = null;      // 현재 Exercise
let detector = null;
let running = null;       // 'camera' | 'file' | 'demo' | null
let stream = null;
let rafId = 0;
let mirror = false;

const setStatus = (t) => { el.status.textContent = t || ""; };

// ---------- 운동 정의 불러오기 ----------
async function loadDefinitions() {
  const names = await (await fetch("exercises/manifest.json")).json();
  await Promise.all(names.map(async (n) => {
    defs[n] = yaml.load(await (await fetch(`exercises/${n}.yaml`)).text());
  }));
  el.exercise.innerHTML = names.map((n) => `<option value="${n}">${defs[n].display_name}</option>`).join("");
  const saved = safeGet("exercise");
  if (saved && defs[saved]) el.exercise.value = saved;
  selectExercise(el.exercise.value);
}

function selectExercise(name) {
  exercise = new Exercise(defs[name]);
  safeSet("exercise", name);
  const d = defs[name];
  const kind = d.type === "duration" ? `목표 ${d.target_duration ?? 30}초 유지` : "";
  el.exInfo.textContent = [d.description, kind].filter(Boolean).join(" · ");
  detector?.setExercise?.(name);
  resetView();
}

function resetView() {
  exercise?.reset();
  el.count.textContent = "0";
  el.countSub.textContent = exercise?.cfg.type === "duration" ? "초" : "회";
  el.scoreBox.hidden = true;
  el.messages.innerHTML = "";
  el.notice.hidden = true;
  el.repLog.innerHTML = "";
  el.summary.textContent = "";
  spoken.clear();
}

// ---------- 시작/정지 ----------
async function ensureDetector() {
  if (DEMO) {
    if (!detector) { detector = new DemoDetector(); await detector.init(); }
    detector.setExercise(el.exercise.value);
    return;
  }
  if (!detector) detector = new PoseDetector();
  setStatus("인식 모델 불러오는 중… (처음 한 번은 몇 초 걸려요)");
  await detector.init(el.model.value);
  setStatus("");
}

async function startCamera() {
  try {
    await ensureDetector();
    if (DEMO) return startLoop("demo");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: el.facing.value, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    el.video.srcObject = stream;
    el.video.removeAttribute("src");
    await el.video.play();
    mirror = el.facing.value === "user";
    startLoop("camera");
  } catch (e) {
    console.error(e);
    setStatus(cameraError(e));
    stop();
  }
}

function cameraError(e) {
  if (/import|fetch|network|\.task|wasm/i.test(e?.message || "")) return "인식 모델을 내려받지 못했어요. 인터넷 연결을 확인하고 다시 눌러주세요";
  if (!window.isSecureContext) return "카메라는 https 주소에서만 켜져요 (Vercel 배포 주소나 localhost로 열어주세요)";
  if (e?.name === "NotAllowedError") return "카메라 권한이 거부됐어요. 브라우저 설정에서 허용해주세요";
  if (e?.name === "NotFoundError") return "카메라를 찾을 수 없어요";
  return `시작하지 못했어요: ${e?.message || e}`;
}

async function startFile(file) {
  if (!file) return;
  try {
    stop();
    await ensureDetector();
    el.video.srcObject = null;
    el.video.src = URL.createObjectURL(file);
    el.video.loop = false;
    mirror = false;
    await el.video.play();
    startLoop("file");
    setStatus("영상 분석 중… 끝까지 재생되면 결과가 정리돼요");
  } catch (e) {
    console.error(e);
    setStatus(`영상을 열지 못했어요: ${e?.message || e}`);
  }
}

function startLoop(mode) {
  resetView();
  running = mode;
  el.video.classList.toggle("mirror", mirror);
  el.btnStop.hidden = false;
  el.btnCamera.disabled = true;
  $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
  if (el.voice.checked) speak(" "); // iOS: 사용자 터치 안에서 음성 엔진 깨우기
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function stop() {
  const was = running;
  running = null;
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (!el.video.paused) el.video.pause();
  el.btnStop.hidden = true;
  el.btnCamera.disabled = false;
  if (was) showSummary();
}

// ---------- 프레임 처리 ----------
let lastVideoTime = -1;
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const v = el.video;
  let lms, W, H, tMs;
  if (running === "demo") {
    lms = detector.detect(); W = 720; H = 1280; tMs = performance.now();
  } else {
    if (running === "file" && v.ended) { setStatus("분석 완료"); stop(); return; }
    if (v.readyState < 2 || v.currentTime === lastVideoTime) return; // 새 프레임만
    lastVideoTime = v.currentTime;
    lms = detector.detect(v);
    W = v.videoWidth; H = v.videoHeight;
    tMs = running === "file" ? v.currentTime * 1000 : performance.now();
  }
  const r = exercise.update(lms, tMs, W, H);
  render(r, lms, W, H);
}

function render(r, lms, W, H) {
  const c = el.overlay;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(c.clientWidth * dpr)) { c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr); }
  const alert = r.feedback.some((f) => f.severity === "warning" || f.severity === "error");
  drawPose(c.getContext("2d"), lms, {
    srcW: W, srcH: H, mirror, visualization: exercise.cfg.visualization,
    pointIndex: r.pointIndex, angles: r.angles, alert,
  });

  // 횟수/시간
  if (exercise.cfg.type === "duration") {
    el.count.textContent = Math.floor(r.holdSec || 0);
    el.countSub.textContent = `초 / 목표 ${r.targetSec}초 · 달성 ${r.counter}회`;
  } else {
    el.count.textContent = r.counter;
    el.countSub.textContent = exercise.cfg.bilateral ? `왼 ${r.counterLeft} · 오른 ${r.counterRight}` : "회";
  }
  if (r.lastScore != null) {
    el.scoreBox.hidden = false;
    el.grade.textContent = r.lastGrade;
    el.score.textContent = `${r.lastScore}점 · 평균 ${r.avgScore}`;
  }

  // 안내/경고
  const notice = r.message || r.viewWarning;
  el.notice.hidden = !notice;
  if (notice) el.notice.textContent = notice;
  const sideName = { L: "왼쪽 ", R: "오른쪽 " };
  const uniq = new Map(r.feedback.map((f) => [f.name, f]));
  el.messages.innerHTML = [...uniq.values()]
    .map((f) => `<li class="${f.severity}">${f.side && exercise.cfg.bilateral ? sideName[f.side] : ""}${escapeHtml(f.message)}</li>`).join("");

  // 음성
  if (r.counted) speak(String(r.counter), "count");
  for (const f of uniq.values()) if (f.severity === "warning" || f.severity === "error") speakOnce(f.name, f.message);
  if (r.repDone) {
    for (const f of r.repDone.faults) if (f.severity === "info") speakOnce(f.name, f.message);
    addRepRow(r.repDone);
  }
  if (exercise.cfg.type === "duration" && r.counted) addHoldRow(r);

  // 디버그
  el.debugBox.hidden = !el.debug.checked;
  if (el.debug.checked) {
    const a = Object.entries(r.angles || {}).map(([k, v]) => `${k}: ${v.toFixed(0)}°`).join("\n");
    const d = Object.entries(r.derived || {}).map(([k, v]) => `${k}: ${v.toFixed(1)}`).join("\n");
    el.debugBox.textContent = `시점: ${r.view ?? "-"}  상태: ${r.state ?? [r.stateLeft, r.stateRight].join("/")}\n${a}\n${d}`;
  }
}

function addRepRow(rep) {
  const li = document.createElement("li");
  const side = rep.side ? (rep.side === "L" ? "왼 " : "오른 ") : "";
  const faults = rep.faults.map((f) => f.message).join(", ");
  li.innerHTML = rep.counted
    ? `<span class="grade g-${rep.grade}">${rep.grade}</span> ${rep.n}회 ${side}${rep.score}점 · ${rep.durationSec}초${faults ? ` <span class="faults">— ${escapeHtml(faults)}</span>` : ""}`
    : `<span class="miss">${side}안 센 동작 — ${escapeHtml(faults)}</span>`;
  el.repLog.prepend(li);
}

function addHoldRow(r) {
  const li = document.createElement("li");
  li.textContent = `목표 ${r.targetSec}초 달성`;
  el.repLog.prepend(li);
}

function showSummary() {
  if (!exercise) return;
  const log = exercise.repLog;
  if (exercise.cfg.type === "duration") {
    el.summary.innerHTML = `최고 유지 <b>${exercise.bestHoldSec.toFixed(1)}초</b> · 목표 달성 <b>${exercise.counter}회</b>`;
    return;
  }
  const counted = log.filter((r) => r.counted);
  const faults = new Map();
  for (const r of log) for (const f of r.faults) faults.set(f.message, (faults.get(f.message) || 0) + 1);
  const top = [...faults.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${escapeHtml(m)} (${n})`).join(", ");
  el.summary.innerHTML = `총 <b>${exercise.counter}회</b>`
    + (counted.length ? ` · 평균 <b>${exercise.avgScore}점</b>` : "")
    + (top ? `<br>자주 나온 문제: ${top}` : counted.length ? "<br>지적된 문제 없음" : "");
}

// ---------- 음성 ----------
const spoken = new Map();
function speak(text, key) {
  if (!el.voice.checked || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  u.rate = 1.1;
  if (key === "count") speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function speakOnce(name, text) {
  const now = performance.now();
  if (now - (spoken.get(name) ?? -1e9) < 5000) return; // 같은 말은 5초에 한 번
  spoken.set(name, now);
  speak(text);
}

// ---------- 유틸 ----------
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } }

// ---------- 이벤트 ----------
el.exercise.addEventListener("change", () => selectExercise(el.exercise.value));
el.btnCamera.addEventListener("click", startCamera);
el.btnStop.addEventListener("click", stop);
el.fileInput.addEventListener("change", () => { startFile(el.fileInput.files[0]); el.fileInput.value = ""; });
el.model.addEventListener("change", () => { if (detector && !DEMO) detector.model = null; });
el.facing.addEventListener("change", () => { if (running === "camera") { stop(); startCamera(); } });

if (DEMO) setStatus("데모 모드: 카메라 대신 가짜 사람으로 화면을 확인합니다 (스쿼트·푸시업·바이셉 컬·점핑 잭)");
loadDefinitions().catch((e) => { console.error(e); setStatus(`운동 정의를 불러오지 못했어요: ${e.message}`); });
