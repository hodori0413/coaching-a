# 운동 자세 코치 (프로토타입)

폰 카메라로 운동하는 모습을 비추거나 촬영한 영상을 넣으면, 관절 각도를 보고 횟수를 세고 잘못된 자세를 알려주는 웹앱.
[yakupzengin/fitness-trainer-pose-estimation](https://github.com/yakupzengin/fitness-trainer-pose-estimation) (MIT)의
운동 정의 18개와 판정 엔진을 폰에서 돌도록 JavaScript로 옮기고 버그를 고친 버전이다.

- 포즈 인식은 폰 브라우저 안에서 MediaPipe로 실행 → 서버 없음, 영상이 밖으로 나가지 않음
- 실시간 카메라 / 촬영·저장한 영상 분석 둘 다 지원
- 나중에 같은 코드를 Capacitor로 감싸면 안드로이드·iOS 설치형 앱이 됨
- UI는 기능 확인용 최소한 (디자인은 나중에)

## 실행

빌드 없음. 정적 파일 그대로 올리면 된다.

| 방법 | 하는 법 |
|---|---|
| 내 PC에서 | 이 폴더에서 `python -m http.server 8000` → 브라우저로 `http://localhost:8000` |
| 폰에서 | GitHub에 올리고 Vercel에 연결 (Framework: Other, 빌드 명령 없음) → https 주소로 접속 |
| 카메라 없이 화면 확인 | 주소 뒤에 `?demo` (가짜 사람이 스쿼트·푸시업·바이셉 컬·점핑 잭을 함) |

카메라는 **https 주소나 localhost에서만** 켜진다. 처음 시작할 때 인식 모델과 실행 파일(합쳐서 십수 MB)을 내려받으므로 인터넷이 필요하다.

### 촬영 방법
- 운동마다 **옆에서** 또는 **정면에서** 찍어야 하는 방향이 정해져 있다 (운동 선택 시 안내). 방향이 틀리면 화면에 안내가 뜬다.
- 몸 전체(머리~발)가 화면에 들어와야 한다.
- 옆에서 찍을 때 어느 쪽을 보고 서든, 어느 쪽 몸이 카메라를 향하든 같은 결과가 나오도록 자동으로 맞춘다.

## 폴더 구조

```
index.html            화면
css/app.css           최소 스타일
js/main.js            화면 연결: 카메라/영상 → 인식 → 엔진 → 표시·음성
js/pose.js            MediaPipe 포즈 인식 (+ ?demo 가짜 사람)
js/engine.js          운동 판정 엔진 (원본 base_exercise.py + engine.py)
js/body.js            관절 좌표 정리: 거리 보정, 정면/측면 판단, 보이는 쪽 선택
js/condition.js       YAML 조건식 해석기 (원본의 Python eval 대체)
js/overlay.js         영상 위 뼈대 그리기
exercises/*.yaml      운동 정의 18개 (원본 기반)
exercises/manifest.json  운동 목록·순서
tools/port_definitions.py  원본 YAML → 이 앱 YAML 변환 스크립트 (무엇을 바꿨는지 여기 다 있음)
test/run.mjs          엔진 테스트 (node test/run.mjs)
test/sim.mjs          테스트용 가짜 사람 (관절 각도 → 랜드마크)
```

## 운동 추가·수정 (코드 수정 없이 YAML만)

`exercises/`에 YAML을 만들고 `manifest.json`에 이름을 넣으면 끝. 원본 형식 그대로이고, 추가된 항목만 정리하면:

```yaml
name: squat
display_name: 스쿼트
view: side              # side | front | any — 권장 촬영 방향 (다르면 안내 표시)
angles:
  primary: { points: [left_shoulder, left_hip, left_knee] }   # 꼭짓점이 가운데
state_order: [ascent, descent, start]   # 위에서부터 먼저 맞는 상태가 선택됨
states:
  start:   { condition: "angle > 165" }
  descent: { condition: "angle > 90 and angle <= 165" }
  ascent:  { condition: "angle <= 90" }
rest_state: start       # (추가) 쉬는 자세. 생략하면 state_order 마지막
counter: { trigger_state: ascent, from_state: descent }
min_rep_duration: 0.8
feedback:
  leaning_forward:
    condition: "trunk_lean > 45"
    states: [descent, ascent]   # (추가) 이 상태일 때만 확인
    view: side                  # (추가) 이 촬영 방향일 때만 확인
    message: 상체가 너무 숙여졌어요
    severity: warning           # warning/error -10점, info -5점, success 감점 없음(칭찬)
  not_deep_enough:
    check: rep_end              # (추가) 한 회가 끝났을 때 그 회 전체를 보고 판단
    condition: "rep_min_angle > 90 and rep_min_angle < 150"
    message: 더 깊이 앉으세요
    severity: info
form_score:
  ideal_angles: { primary: 80 }       # 횟수가 세지는 순간의 목표 각도 (10° 벗어날 때마다 -5점, 최대 -40)
  tempo_range: { min: 1.5, max: 6.0 } # 한 회 시간(초) (최대 -30)
```

### 조건식에서 쓸 수 있는 것
- 연산: `+ - * / %`, `< <= > >= == !=` (`90 < angle < 130`처럼 이어 쓰기 가능), `and or not`, `abs() min() max()`
- `angle` — primary 각도 (좌우 운동은 각 팔/다리 각도)
- `<각도이름>_angle` — 예: `torso_angle`, `body_line_angle`
- `<관절>_x`, `<관절>_y` — MediaPipe 33개 관절 이름 전부 (`left_heel`, `right_foot_index` 등). y는 아래로 갈수록 커짐
  - **단위: 몸통 길이(어깨 중앙~골반 중앙) = 200.** 폰과의 거리와 상관없이 같은 의미
  - 측면에서는 사람이 바라보는 방향이 항상 +x, 카메라 쪽 몸이 `left_*`
- `front_hip/knee/ankle/heel/foot_index`, `back_*` — 측면에서 발목이 더 앞에 있는 다리 (런지용)
- `trunk_lean` — 체간 기울기(°). 측면에서 +면 앞으로 숙임, −면 뒤로 젖힘
- `hip_line_offset` — 엉덩이가 어깨-발목 선보다 아래(+)/위(−) (플랭크·푸시업처럼 누운 자세에서만)
- `rep_end` 규칙 전용: `rep_min_angle`, `rep_max_angle`, `rep_min_<이름>_angle`, `rep_max_<이름>_angle`, `rep_counted`, `rep_duration`

## 원본에서 고친 것

같은 가짜 동작을 원본 Python 엔진과 이 엔진에 넣어서 확인했다.

| 문제 (원본) | 원본 결과 | 수정 후 |
|---|---|---|
| 데드리프트·트라이셉 딥: `from_state`에서 '바로' 넘어갈 때만 세는데 중간 상태가 끼어 있음 | 0회 | 정상 카운트 |
| 바이셉 컬·하이 니·마운틴 클라이머: 좌우 각도 정의 없음 | 0회 | primary를 좌우로 복제 |
| 월싯: 유지 상태 이름 불일치 | 타이머 0초 | 정상 |
| 각도 스무딩이 모든 각도를 한 기록에 섞음 | 런지에서 무릎 180°·상체 90° → 셋 다 150° | 각도별로 따로 |
| 카프 레이즈: 무릎 각도로 셈 | 무릎을 굽혀야 세짐 | 뒤꿈치 높이로 셈 |
| 플랭크 '엉덩이 들림': 각도 > 185 | 절대 안 걸림 | 어깨-발목 선 기준 |
| 픽셀 고정 기준값 (1280×720) | 거리·해상도마다 결과 다름 | 몸통 길이 기준으로 정규화 |
| 항상 왼쪽 관절만 사용 | 오른쪽이 카메라를 향하면 가려진 관절로 판정 | 보이는 쪽 자동 선택 |
| '덜 내려감/덜 올림' 경고가 매 프레임 판정 | 정상 동작 도중에도 계속 경고 | 한 회가 끝났을 때 판정 |
| 정면용·측면용 규칙이 섞임 (스쿼트 무릎 모임 등) | 측면에서 엉뚱한 경고 | 규칙별 `view` 지정 |
| 폼 점수 기준이 정의된 운동 없음, 매 프레임 계산 | 사실상 경고 개수만 반영, 깜빡임 | 회마다 계산 |
| 조건식을 Python `eval()`로 실행 | — | 안전한 전용 해석기 |

운동별 자세한 변경 내용은 각 YAML 파일 맨 위 주석에 있다.

## 한계 / 해야 할 것

- **판정 기준값은 원본 숫자이거나 임시값이다.** 임상적으로 맞는 기준으로 다시 정해야 한다 (YAML만 고치면 됨).
- 2D 카메라 한 대라서 측면에서는 무릎 모임·좌우 차이, 정면에서는 앉은 깊이·상체 숙임을 정확히 볼 수 없다.
- 데드리프트 '허리 굽음'처럼 관절 3개 각도로는 원리상 알 수 없는 항목이 있다 (메시지를 실제 의미에 맞게 바꿈).
- 테스트는 가짜 사람(시뮬레이션)으로만 했다. **실제 사람 영상으로 각 운동을 찍어 확인해야 한다.**
- 앱 포장(Capacitor) 시: MediaPipe 파일과 모델을 앱 안에 넣어야 오프라인에서도 동작.
- 좌우 운동(바이셉 컬 등)은 양팔을 동시에 하면 왼쪽·오른쪽이 각각 세진다 (원본과 같은 방식).

## 테스트

```
node test/run.mjs      # Node 18 이상
```

## 라이선스

- 원본 레포: MIT © 2024 Yakup Zengin — `LICENSE-original-fitness-trainer.txt`
- js-yaml: MIT — `js/vendor/js-yaml.LICENSE`
- MediaPipe: Apache 2.0 (CDN에서 불러옴)
