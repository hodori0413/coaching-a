#!/usr/bin/env python3
"""
원본 레포의 exercises/definitions/*.yaml → 앱용 exercises/*.yaml 변환
- 원본 각도·상태 기준값은 그대로 두고, 동작하지 않거나 잘못된 규칙만 고친다
- 메시지/이름은 한국어로
- 각 파일 맨 위에 무엇을 바꿨는지 주석으로 남긴다

사용: python3 tools/port_definitions.py <원본 definitions 폴더> <출력 폴더>
"""
import copy
import json
import sys
from pathlib import Path

import yaml

TEMPO = {"tempo_range": {"min": 1.5, "max": 6.0}}  # 한 회(내려갔다 올라오기) 전체 시간, 임시값

# name: dict(display_name, description, view, replace={...}, feedback={...}, drop=[...], changes=[...])
P = {
    "squat": dict(
        display_name="스쿼트", description="하체 기본 운동 — 옆에서 찍어주세요", view="side",
        replace={"form_score": TEMPO},
        feedback={
            "leaning_forward": dict(condition="trunk_lean > 45", view="side", states=["descent", "ascent"],
                                    message="상체가 너무 숙여졌어요. 가슴을 펴세요", severity="warning"),
            "not_deep_enough": dict(check="rep_end", condition="rep_min_angle > 90 and rep_min_angle < 150",
                                    message="더 깊이 앉으세요", severity="info"),
            "knees_caving": dict(condition="left_knee_x < left_ankle_x - 20", view="front", states=["descent", "ascent"],
                                 message="왼무릎이 안으로 모여요. 무릎을 발끝 방향으로", severity="warning"),
            "knees_caving_right": dict(condition="right_knee_x > right_ankle_x + 20", view="front", states=["descent", "ascent"],
                                       message="오른무릎이 안으로 모여요. 무릎을 발끝 방향으로", severity="warning"),
        },
        changes=[
            "leaning_forward: 원본(어깨가 엉덩이보다 50px 앞)은 정상 스쿼트에서도 매번 걸림 → 체간 기울기 45° 초과로 변경 (임시 기준)",
            "not_deep_enough: 원본은 내려가는 도중 100~130°를 지날 때마다 걸림 → 한 회가 끝났을 때 목표 깊이 미달이면 표시",
            "knees_caving: 측면에서는 볼 수 없는 규칙이라 정면 촬영일 때만 적용, 오른쪽 무릎 규칙 추가",
            "폼 점수 속도 기준 추가 (원본은 스쿼트/푸시업에만 속도 감점이 있었음)",
        ],
    ),
    "push_up": dict(
        display_name="푸시업", description="옆에서 찍어주세요", view="side",
        angles_add={"body_line": {"points": ["left_shoulder", "left_hip", "left_ankle"]}},
        replace={"form_score": TEMPO},
        feedback={
            "hips_too_high": dict(condition="body_line_angle < 165 and hip_line_offset < 0", view="side",
                                  message="엉덩이가 너무 올라갔어요. 몸을 일직선으로", severity="warning"),
            "hips_sagging": dict(condition="body_line_angle < 165 and hip_line_offset > 0", view="side",
                                 message="허리가 처졌어요. 복부에 힘을 주세요", severity="warning"),
            "arms_too_wide": dict(condition="abs(left_elbow_x - left_shoulder_x) > 100", view="front",
                                  message="팔꿈치가 너무 벌어졌어요", severity="info"),
        },
        changes=[
            "hips_sagging/hips_too_high: 원본(어깨·엉덩이 높이 차)은 팔을 편 정상 자세에서도 걸림 → 어깨-엉덩이-발목 일직선 각도로 변경",
            "arms_too_wide: 측면에서는 팔 벌림을 볼 수 없어 정면 촬영일 때만 적용",
        ],
    ),
    "lunge": dict(
        display_name="런지", description="옆에서 찍어주세요", view="side",
        angles_replace={
            "primary": {"points": ["front_hip", "front_knee", "front_ankle"], "description": "앞다리 무릎"},
            "back_leg": {"points": ["back_hip", "back_knee", "back_ankle"], "description": "뒷다리 무릎"},
            "torso": {"points": ["left_shoulder", "front_hip", "front_knee"], "description": "상체-앞허벅지"},
        },
        replace={"form_score": TEMPO},
        feedback={
            "knee_over_toe": dict(condition="front_knee_x > front_ankle_x + 50", states=["descent", "bottom"],
                                  message="앞무릎이 너무 앞으로 나갔어요", severity="warning"),
            "torso_leaning": dict(condition="torso_angle < 70", states=["descent", "bottom"],
                                  message="상체를 세워주세요", severity="warning"),
            "back_knee_touch": dict(condition="back_knee_y > back_ankle_y - 20",
                                    message="뒷무릎이 바닥에 닿지 않게 하세요", severity="info"),
        },
        changes=[
            "원본은 항상 왼다리를 앞다리로 가정 → 발목이 더 앞에 있는 다리를 앞다리로 자동 선택 (front_*/back_*)",
        ],
    ),
    "side_lunge": dict(
        display_name="사이드 런지", description="정면에서 찍어주세요 (왼쪽으로 앉는 동작 기준)", view="front", auto_side=False,
        replace={"form_score": TEMPO},
        feedback={
            "knee_caving": dict(condition="left_knee_x < left_ankle_x", states=["descent", "bottom"],
                                message="무릎이 안으로 모여요", severity="warning"),
            "standing_leg_bent": dict(condition="standing_leg_angle < 160", states=["descent", "bottom"],
                                      message="반대쪽 다리는 펴주세요", severity="warning"),
        },
        changes=["정면 촬영 전용으로 지정"],
    ),
    "bicep_curl": dict(
        display_name="바이셉 컬", description="좌우 팔을 따로 셉니다", view="any",
        feedback={
            "partial_rep": dict(check="rep_end", condition="rep_min_angle > 50 and rep_min_angle < 120",
                                message="끝까지 들어올리세요", severity="info"),
        },
        changes=[
            "[버그] left/right 각도 정의가 없어 횟수가 안 셈 → 엔진에서 primary를 좌우로 복제",
            "partial_rep: 원본(각도>60)은 팔을 내린 상태 내내 걸림 → 한 회가 끝났을 때 덜 올렸으면 표시",
        ],
    ),
    "hammer_curl": dict(
        display_name="해머 컬", description="좌우 팔을 따로 셉니다", view="any",
        feedback={
            "too_fast": dict(condition="angle < 40", message="좋아요! 위에서 잠깐 멈추세요", severity="success"),
            "partial_rep": dict(check="rep_end", condition="rep_min_angle > 47 and rep_min_angle < 130",
                                message="끝까지 들어올리세요", severity="info"),
        },
        changes=[
            "too_fast: 칭찬 메시지라 감점 없는 success로",
            "partial_rep: 원본(각도>160)은 팔을 다 편 '정상' 자세에서 걸림 → 덜 올렸을 때 표시로 변경",
        ],
    ),
    "calf_raise": dict(
        display_name="카프 레이즈", description="옆에서 찍어주세요", view="side",
        states_replace={
            "down": "left_foot_index_y - left_heel_y < 8",
            "raise": "left_foot_index_y - left_heel_y >= 8 and left_foot_index_y - left_heel_y < 20",
            "up": "left_foot_index_y - left_heel_y >= 20",
        },
        feedback={
            "bent_knees": dict(condition="angle < 150", message="무릎을 펴세요", severity="warning"),
        },
        changes=[
            "[설계 오류] 원본은 무릎 각도로 횟수를 세서 '무릎을 굽힐 때' 세짐 (자기 경고 규칙과도 모순)",
            "→ 뒤꿈치가 발끝보다 올라간 높이(몸통 길이 기준 단위)로 상태 판단. 8/20은 임시값",
        ],
    ),
    "deadlift": dict(
        display_name="데드리프트", description="옆에서 찍어주세요", view="side", rest_state="up",
        feedback={
            "rounded_back": dict(condition="angle < 90",
                                 message="상체를 너무 깊이 숙였어요. 엉덩이를 뒤로 빼세요", severity="warning"),
        },
        changes=[
            "rest_state: up (선 자세에서 시작)",
            "rounded_back: 실제로는 고관절 각도만 봄(허리 굽음은 알 수 없음) → 메시지를 실제 의미에 맞게",
        ],
    ),
    "glute_bridge": dict(
        display_name="글루트 브릿지", description="옆에서 찍어주세요", view="side",
        feedback={
            "incomplete": dict(check="rep_end", condition="rep_max_angle >= 130 and rep_max_angle < 165",
                               message="엉덩이를 끝까지 들어올리세요", severity="info"),
        },
        changes=["incomplete: 원본(각도<160)은 누워있는 동안 내내 걸림 → 한 회가 끝났을 때 덜 올렸으면 표시"],
    ),
    "high_knees": dict(
        display_name="하이 니", description="옆에서 찍어주세요. 좌우 다리를 따로 셉니다", view="side",
        feedback={
            "knee_low": dict(check="rep_end", condition="rep_min_angle > 100 and rep_min_angle < 140",
                             message="무릎을 더 높이 올리세요", severity="info"),
        },
        changes=[
            "[버그] left/right 각도 정의가 없어 횟수가 안 셈 → 엔진에서 primary를 좌우로 복제",
            "knee_low: 원본(각도>110)은 다리를 내린 동안 내내 걸림 → 덜 올렸을 때만 표시",
        ],
    ),
    "jumping_jack": dict(
        display_name="점핑 잭", description="정면에서 찍어주세요", view="front",
        feedback={
            "arms_low": dict(check="rep_end", condition="rep_max_angle > 60 and rep_max_angle < 150",
                             message="팔을 머리 위까지 올리세요", severity="info"),
        },
        changes=["arms_low: 원본(각도<140)은 팔을 내린 동안 내내 걸림 → 덜 올렸을 때만 표시"],
    ),
    "lateral_raise": dict(
        display_name="레터럴 레이즈", description="정면에서 찍어주세요", view="front",
        feedback={
            "swinging": dict(condition="abs(left_hip_y - right_hip_y) > 30", view="front",
                             message="몸을 흔들지 마세요. 천천히", severity="warning"),
            "too_high": dict(condition="angle > 100", message="어깨 높이까지만 올리세요", severity="warning"),
            "bent_elbows": dict(condition="abs(left_shoulder_x - left_wrist_x) < 50", states=["top"],
                                message="팔꿈치를 너무 굽혔어요. 팔을 조금 더 펴세요", severity="info"),
        },
        changes=["bent_elbows: 원본은 팔을 내린 시작 자세에서도 걸림 → 맨 위(top)에서만 확인"],
    ),
    "leg_raise": dict(
        display_name="레그 레이즈", description="누운 상태를 옆에서 찍어주세요", view="side",
        feedback={
            "momentum": dict(condition="angle < 80", message="반동 없이 천천히 올리세요", severity="warning"),
        },
    ),
    "mountain_climber": dict(
        display_name="마운틴 클라이머", description="옆에서 찍어주세요. 좌우 다리를 따로 셉니다", view="side",
        feedback={
            "hips_high": dict(condition="angle < 70", states=["tucked"], message="엉덩이 높이를 유지하세요", severity="info"),
        },
        changes=["[버그] left/right 각도 정의가 없어 횟수가 안 셈 → 엔진에서 primary를 좌우로 복제"],
    ),
    "plank": dict(
        display_name="플랭크", description="옆에서 찍어주세요", view="side",
        feedback={
            "hips_too_high": dict(condition="body_line_angle < 170 and hip_line_offset < 0",
                                  message="엉덩이가 너무 올라갔어요. 몸을 일직선으로", severity="warning"),
            "hips_sagging": dict(condition="body_line_angle < 170 and hip_line_offset > 0",
                                 message="허리가 처졌어요. 복부에 힘을 주세요", severity="warning"),
            "good_form": dict(condition="body_line_angle >= 170", message="좋은 자세예요! 유지하세요", severity="success"),
        },
        changes=[
            "hips_too_high: 원본(각도>185)은 각도가 180을 넘을 수 없어 절대 안 걸림 → 엉덩이가 일직선보다 위인지로 판단",
            "hips_sagging: 원본은 엉덩이가 올라가도 '처짐'으로 표시 → 아래/위 구분",
            "good_form: 칭찬 메시지라 감점 없는 success로",
        ],
    ),
    "shoulder_press": dict(
        display_name="숄더 프레스", description="정면에서 찍어주세요", view="front",
        feedback={
            "arching_back": dict(condition="trunk_lean < -10", view="side",
                                 message="허리를 젖히지 마세요. 복부에 힘을 주세요", severity="warning"),
            "uneven_arms": dict(condition="abs(left_wrist_y - right_wrist_y) > 50", view="front", states=["press", "top"],
                                message="양팔을 같은 높이로 올리세요", severity="warning"),
        },
        changes=[
            "arching_back: 원본(어깨가 엉덩이보다 100px 위)은 서 있기만 해도 걸림 → 측면에서 상체가 뒤로 10° 넘게 젖혀질 때",
        ],
    ),
    "tricep_dip": dict(
        display_name="트라이셉 딥", description="옆에서 찍어주세요", view="side", rest_state="up",
        feedback={
            "shallow": dict(check="rep_end", condition="rep_min_angle > 90 and rep_min_angle < 150",
                            message="팔꿈치가 90°가 될 때까지 내려가세요", severity="info"),
        },
        changes=["rest_state: up", "shallow: 원본(각도>100)은 팔을 편 동안 내내 걸림 → 덜 내려갔을 때만 표시"],
    ),
    "wall_sit": dict(
        display_name="월 싯", description="옆에서 찍어주세요", view="side",
        hold_state="holding", target_duration=30,
        feedback={
            "too_high": dict(condition="angle > 100", states=["lowering"], message="무릎이 90°가 되게 더 내려가세요", severity="warning"),
        },
        changes=["[버그] 유지 상태 이름이 맞지 않아 타이머가 안 돎 → hold_state: holding, target_duration: 30 추가"],
    ),
}

ORDER = ["name", "display_name", "type", "bilateral", "view", "auto_side", "description", "target_muscles", "equipment",
         "difficulty", "default_reps", "default_sets", "rest_time", "benefits", "angles", "state_order", "states",
         "rest_state", "counter", "hold_state", "target_duration", "min_rep_duration", "feedback", "form_score",
         "calibration", "smoothing", "visualization"]


def port(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)
    manifest = []
    for f in sorted(src.glob("*.yaml")):
        c = yaml.safe_load(f.read_text(encoding="utf-8"))
        name = c["name"]
        p = P[name]
        out = copy.deepcopy(c)
        out["display_name"] = p["display_name"]
        out["description"] = p["description"]
        out["view"] = p["view"]
        if "auto_side" in p:
            out["auto_side"] = p["auto_side"]
        for k in ("rest_state", "hold_state", "target_duration"):
            if k in p:
                out[k] = p[k]
        if "angles_replace" in p:
            out["angles"].update(p["angles_replace"])
        if "angles_add" in p:
            out["angles"].update(p["angles_add"])
        if "states_replace" in p:
            for s, cond in p["states_replace"].items():
                out["states"][s]["condition"] = cond
        for s in out["states"].values():
            s.pop("description", None)
        for k, v in p.get("replace", {}).items():
            out[k] = v
        out["feedback"] = p["feedback"]
        if out.get("type") == "duration":
            out.pop("counter", None)
        ordered = {k: out[k] for k in ORDER if k in out}
        ordered.update({k: v for k, v in out.items() if k not in ordered})

        header = [f"# {p['display_name']} — 원본: yakupzengin/fitness-trainer-pose-estimation exercises/definitions/{f.name} (MIT)"]
        header.append("# 원본의 각도·상태 기준값은 유지. 바꾼 점:")
        header += [f"#  - {ch}" for ch in p.get("changes", [])] or ["#  - 메시지 한국어화만"]
        header.append("#  - 메시지/이름 한국어화, view(촬영 방향) 추가")
        body = yaml.safe_dump(ordered, allow_unicode=True, sort_keys=False, width=120)
        (dst / f.name).write_text("\n".join(header) + "\n\n" + body, encoding="utf-8")
        manifest.append(f.stem)

    order = ["squat", "lunge", "push_up", "plank", "deadlift", "glute_bridge", "calf_raise", "wall_sit", "side_lunge",
             "bicep_curl", "hammer_curl", "shoulder_press", "lateral_raise", "tricep_dip", "jumping_jack", "high_knees",
             "mountain_climber", "leg_raise"]
    assert sorted(order) == sorted(manifest), set(order) ^ set(manifest)
    (dst / "manifest.json").write_text(json.dumps(order, indent=2) + "\n", encoding="utf-8")
    print(f"{len(manifest)}개 변환 완료 → {dst}")


if __name__ == "__main__":
    port(Path(sys.argv[1]), Path(sys.argv[2]))
