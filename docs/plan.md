# PoseBlock 3D v2.1.4 Plan

## 목표
2인 이미지에서 A/B가 동일 인물로 중복 인식되는 사례를 차단하고, 사람 영역을 ID 기준으로 고정한 뒤 각 영역에 기존 1인 포즈 분석을 독립 적용한다.

## 구현
1. Object Detector person bounding box를 우선 사용한다.
2. 화면 왼쪽 box=A, 오른쪽 box=B로 고정한다.
3. 각 box를 좁은 여백부터 단계적으로 crop하여 `numPoses=1` 분석한다.
4. 결과 torso center와 어깨/골반 핵심점이 배정 box에 속하는지 검증한다.
5. A/B 결과가 동일 인물로 판단되면 B를 폐기한다.
6. Object Detector가 두 영역을 못 만들 때만 rough `numPoses=2`를 ROI fallback으로 사용한다.
7. 1인 이미지 처리와 기타 기능은 변경하지 않는다.
