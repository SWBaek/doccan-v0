# 실제 검증 결과

2026-10-05, Windows / Python 3.13.5 / docling-core 2.93.0에서 검증했습니다. 원본 PDF와의 변환 정확성이나 문서 전체의 사람 검수 완료를 뜻하지 않습니다.

## 전체 Asset

| 검사 | 결과 |
|---|---|
| DoclingDocument 공식 모델 | 스키마 1.10.0 검증 통과 |
| 전체 범위 | 138페이지, texts 2,937 / tables 71 / pictures 29 / groups 73 |
| 로컬 JSON 참조 | 6,307건 해석, self_ref/부모·자식/순환 검사 통과 |
| 이미지 연결 | 167건: 페이지 138 + 그림 29, 파일 및 픽셀 크기 검사 통과 |
| 원점 | 요소 BOTTOMLEFT 3,055건 / 셀 TOPLEFT 2,991건 |
| 원점 변환 | 공식 BoundingBox 변환과 비교 통과, 실제 문단·표·그림 영역을 브라우저로 확인 |
| 공식 HTML 항목 표시 | 138페이지 모두 렌더링; 고유 3,037항목 선택 연결, 그림 29개 로컬 이미지 유지 |
| 의심 후보 | 12건, 모두 초기 미확인. 여러 prov 9건 / 수식 2건 / 겹친 표 구조 1건 |
| 입력의 구조 경고 | `#/tables/56`(86페이지) 셀 범위 겹침 1건. 원본 그대로 보존 |

전체 연결 검사 결과: [asset-validation.json](../verification/asset-validation.json).

## 수정·보존 검증

별도 임시 Asset에서 자동 테스트 **6개 모두 통과**했습니다. 최종 실행은 91.421초입니다. [테스트 출력](../verification/unit-tests-final.txt).

- 텍스트·유형·표 셀 각각 제안 시 작업 사본 불변 → 승인 → 실제 JSON 저장 → Store 종료/재열기 → 값 유지.
- 연속 3개 수정의 역순 되돌림으로 최초 JSON 내용과 검수 상태까지 복구.
- charspan 갱신과 최초 orig/bbox 보존. 셀 bbox·행열 구조 보존.
- 오래된 revision, 승인 재사용, 잘못된 Asset, 미지원 구조 변경, 음수 셀 index, 여러 prov의 텍스트 수정, 임의 patch 필드 거부.
- 유지/보류 상태, 셀 교정 시 표 전체의 과거 유지 판단 무효화, 상태 되돌림.
- 내보낸 JSON 손상 모의 후 DB 확정 revision으로 재실행 복구. 동일 작업 폴더의 두 번째 writer 거부.
- 시험용 원본 파일 변경 시 승인 거부. ZIP과 원본 보존 확인.

초기 시험에서 이력의 변경 전 객체가 수정 대상과 같은 객체를 참조하는 결함을 발견했습니다. 독립 깊은 복사로 고쳤고 연속 되돌림 회귀 테스트가 통과했습니다. 초기 실패 기록은 `verification/unit-tests.txt`에 남겨 두었습니다.

## 실제 브라우저

시험용 `verification/browser-data`, 52742 포트에서 실제 버튼 클릭으로 검증했습니다. 주 작업 폴더 `data`에는 시험 교정을 하지 않았습니다.

- 텍스트·유형·표 셀의 제안 전후 차이 확인 → 승인 버튼 → 새로고침 → 저장값 확인 → 이력에서 3회 되돌림: **PASS**.
- 유지·보류 제안 승인, 상태 저장, 2회 되돌림 및 제안 거절: **PASS**.
- 에이전트 요청 클립보드에 Asset/ref/cell 포함, 마지막 138페이지 표시, 의심 목록의 겹친 표 접근: **PASS**.
- 세션 토큰 누락·다른 웹 Origin의 쓰기: **403 거부**.
- 최종 교정 흐름에서 브라우저 console/page 오류: **0건**.
- 실제 CLI `propose`의 UTF-8 파일 제출도 시험 포트에서 확인했고, 해당 제안은 화면에서 거절했습니다.

근거: [교정 흐름](../verification/browser-tests-final.txt), [유지·보류·거절](../verification/browser-decisions.txt), [CLI 결과](../verification/cli-proposal-result.json).

원본 위치 확인 화면: [문단](../verification/paragraph-region.png), [표 전체](../verification/table-region.png), [표 셀](../verification/table-cell-region.png), [그림](../verification/picture-region.png). 화면은 시험용 사본이며 스크린샷의 revision은 실제 작업 사본의 revision과 다릅니다.

## 최종 보존 확인

[final-audit.json](../verification/final-audit.json)에서 다음을 확인했습니다.

- 입력 ZIP SHA-256: `af973df9eca6c22107401ce4ed63034e70b9d61c23aa58f9ddfc6b707c0962c1`, 초기 기록과 동일.
- 최초 JSON 및 PNG **168파일**은 ZIP 안의 바이트와 일치.
- 작업 사본의 PNG **167파일**도 원본과 동일.
- 실제 작업 사본: **revision 0**, JSON 내용은 최초 데이터와 같음, 검수 상태 없음.
- 시험용 사본: 되돌림 후 JSON 내용과 검수 상태가 최초 상태로 복구됨, 대기 제안 0개. 시험 이력은 남아 있음.

## 남은 제한

분리·병합·재배치·표 구조 수정과 여러 prov 텍스트 교정은 지원하지 않습니다. 겹친 표 셀은 공식 HTML 격자에서 누락·합쳐 보일 수 있어 JSON 셀 목록으로 식별해야 합니다. 에이전트의 자동 원본 판독은 구현하지 않았습니다. 공식 HTML은 표시용이며 수정 기준은 JSON입니다. 단일 PC·단일 사용자 검수용이고 사용자 인증·다중 사용자 충돌 조정·PDF 전체 정확성 평가를 제공하지 않습니다.
