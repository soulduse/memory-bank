# Galaxy 시각화 성능 개선 (버벅임 제거)

## 진단 (실측 기반)

- ~~가설1: 매 프레임 24k 포인트 raycast~~ → **반증**: 마이크로벤치 0.38ms/call (프레임 예산 2%)
- 확정 병목 후보 (실측·구조 분석):
  1. **DOM 라벨 repaint**: 16개 `.clabel`(22px+60px blur text-shadow)을 `left/top`으로
     매 프레임 재배치 + opacity 변경 → 프레임마다 블러 텍스트 재래스터
  2. **포인트 크기 무제한**: `gl_PointSize = size*(uScale/-mv.z)` — 줌인 시 스프라이트가
     수백 px로 커져 additive blending fill-rate 폭발 (탐색 중 순간 버벅임)
  3. **dpr2 + antialias**: 2880×1800 백버퍼 MSAA — glow 장면에 시각 이득 미미

## 수정 (app.js + index.html 소폭)

1. 라벨: `transform: translate3d` + `will-change` (compositor-only 이동, repaint 0)
2. 셰이더: `gl_PointSize` 상한 26px (fill 폭발 차단)
3. renderer: dpr>1.25면 antialias off + `powerPreference:'high-performance'`
4. eco-mode(nagix): 프레임타임 롤링 avg>28ms → pixelRatio 0.25씩 강등 (degrade-only, 안정)
5. raycast throttle: pointermove-dirty + 150ms cadence (2%도 절약, 공짜)
6. updateLabels Vector3 재사용 (GC 압력 제거)

## 수용 기준

- [ ] 기능 동일: hover 카드·click 패널·검색·도메인브라우저·엣지토글 (브라우저 재검증)
- [ ] console error 0
- [ ] 병목 수정의 객관 증거 (repaint 경로 제거·포인트 상한·백버퍼 감소 확인)
- [ ] 자동화 탭 rAF 스로틀로 FPS 직접 측정 불가 시 정직 고지 + 사용자 체감 확인 요청

## Deviations

- 자동화 브라우저 탭이 occluded 상태에서 rAF가 발화하지 않아 before/after FPS 수치 측정 불가
  → 병목별 객관 증거(마이크로벤치·구조 변화)로 대체, 최종 체감은 사용자 브라우저에서.
