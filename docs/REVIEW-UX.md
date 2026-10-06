# 대화 중심 검수 화면

기본 화면을 **왼쪽 검수 대화 / 오른쪽 현재 원본 근거**로 바꿨습니다. 제안은 대화의 단일 스크롤 안에 표시하고, 승인하면 바뀌는 항목 수·변경 전후·이유·선택을 한 카드에 모았습니다. 1000px 이하에서는 대화와 근거를 전환합니다.

## 시작과 판단

기존 서버는 자동 재시작하지 않습니다. 사용자가 기존 서버를 종료한 뒤 `./start.ps1 -ChatConfig ./config/codex.example.json`으로 실행하세요.

1. **Codex 연결·모델 조회 → 모델·Reasoning effort 선택 → 검수 시작**. 시작이 설정 적용을 함께 수행합니다. 목록은 기존 공식 실행기 조회를 사용하며 정적 모델 목록이나 대체 모델을 추가하지 않았습니다.
2. 에이전트 설명 아래 카드에서 **전체 몇 개를 어떻게 바꾸는지** 확인합니다. 오른쪽은 현재 사례의 페이지·위치와 전체 대상 중 순번을 표시합니다. `해당 영역 / 전체 페이지`와 확대를 사용할 수 있습니다.
3. `전체 대상·예외 확인`에서 포함 여부를 바꿉니다. 조정 중에는 승인과 전송이 잠기며, **선택한 범위로 수정안 갱신 → 새 범위 확인 → 승인**이 필요합니다. 갱신은 문서를 바꾸지 않습니다.
4. 입력창으로 질문하거나 “응”, “그대로 둬”, “보류해”라고 답합니다. 카드의 판단 버튼도 같은 실제 사용자 메시지 경로를 사용합니다. 설명 뒤의 모호한 “응”은 제안을 재확인할 뿐 적용하지 않습니다.
5. 적용 결과와 다음 문제는 같은 대화에 이어집니다. 원본에서 다른 항목을 탐색해도 승인 범위는 바뀌지 않습니다. **선택한 항목으로 새 질문**을 누르면 질문 대상이 명시적으로 바뀌고, 전송 후 선택 이동은 그 질문과 제안을 바꾸지 않습니다.

시작 후 모델 설정은 상단 요약으로 접힙니다. 변경은 펼친 설정에서 `다음 턴부터 변경`을 눌러 적용합니다. 작업 중단·일시정지·재개·재시도는 기존 서버의 의미를 그대로 사용합니다. 재개는 이전 메시지나 승인을 자동으로 다시 보내지 않습니다.

## 보조 기능 위치

| 이전 요소 | 현재 경로와 역할 |
|---|---|
| 상시 수동 편집 열 | 원본 옆 **직접 수정**. 제안 작성·검토·승인은 기존 경로를 사용하며 닫으면 대화로 복귀 |
| 문제 묶음·의심 후보·제안 메뉴 | **문서 탐색** 안의 진단 묶음, 개별 확인 후보, 개별 교정 제안. 검색·페이지 탐색도 같은 진입점 |
| 별도 개별 채팅 입력 | 현재 대화의 **선택한 항목으로 새 질문**으로 통합. 이전 기록은 이력·내보내기 안에서 읽기 |
| 이력·실행 취소·JSON 다운로드 | **이력·내보내기**. 다음/이전 문제 수동 이동도 여기에서 가능 |
| revision·제안 ID·원시 JSON·연결 상태 | 카드·메시지·직접 수정·도구 영역의 접힌 **상세정보** |
| 상시 설정 적용 + 시작 버튼 | 시작 전에는 **검수 시작** 하나로 적용. 시작 후 변경 때만 설정을 펼침 |

직접 수정 창을 닫은 상태는 새로고침으로 다시 열리지 않습니다. 초안·검토 중인 개별 제안 자체는 보존합니다. 오류·일시정지·저장 복구 상태를 표시하며, 키보드 초점 표시와 대화상자의 Escape 닫기·초점 복귀를 제공합니다.

## 전후 화면

모든 화면은 격리 Asset과 **모의 실행기**로 촬영했습니다. 화면의 `mock-*`는 실제 서비스 모델 이름이 아닙니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| 1366×768 | [3열·분리 스크롤](../verification/review-ux-20261006/before-review-1366.png) | [대화 + 원본 근거](../verification/review-ux-20261006/after-review-1366.png) |
| 1920×1080 | [기존 화면](../verification/review-ux-20261006/before-review-1920.png) | [새 화면](../verification/review-ux-20261006/after-review-1920.png) |
| 390×844 | [기존 좁은 화면](../verification/review-ux-20261006/before-review-390.png) | [대화](../verification/review-ux-20261006/after-review-390.png) · [원본](../verification/review-ux-20261006/after-current-evidence-390.png) |

[시작 전](../verification/review-ux-20261006/after-start-1366.png), [예외 반영](../verification/review-ux-20261006/after-exception.png), [오류](../verification/review-ux-20261006/after-error.png), [재시작 복원](../verification/review-ux-20261006/after-restart.png), [내보내기 미완료](../verification/review-ux-20261006/after-export-pending.png), [저장 복구](../verification/review-ux-20261006/after-export-recovered.png).

## 검증 결과

- **전체 unittest 67개 통과**(407.832초). 기존 65개와 범위 조정 회귀 2개: [실행 로그](../verification/review-ux-20261006/all-tests.txt). 새 범위는 불변 제안이며, 중복 요청·범위 밖 항목·이전 승인·중단·문서 충돌·재시작·되돌림을 검증했습니다.
- [실제 브라우저 주 흐름](../verification/review-ux-20261006/browser-flow.txt): `mock-b/high`가 실제 요청에 반영됨. 57개 제안 → 다른 원본 탐색 → 직접 수정 창 복귀 → 예외 1개 → 새로고침 → 질문·모호한 답변 재확인 → 56개 승인 → 42개 유지 → 1개 보류. 오류 후 재시도, 실행 중 중단·재개, 1366/1920/390px의 가로 넘침·입력창 접근·모바일 전환 확인. 모두 되돌려 시작 문서와 일치.
- [안전성 브라우저 시험](../verification/review-ux-20261006/browser-safety-final.txt): 늦은 상태 응답, 범위 변경 응답 유실, 임의 두 대상 제외(55개), 이전 범위 승인 차단, 중복 클릭의 단일 요청, 적용 응답 유실 복구, 같은 승인 ID 재접수, 직접 수정 후 409 충돌. 셀 73 제안 후 셀 72를 보며 승인해도 **73만 변경**. 모두 되돌림.
- [서버 재시작](../verification/review-ux-20261006/browser-resume.txt): 57개 미결 제안·설정·문서 상태 복원. 새 실행과 승인 재전송 없음.
- [마지막 화면·키보드 점검](../verification/review-ux-20261006/browser-final-ui.txt): 문서 탐색·직접 수정·도구 창에서 Enter로 열기, 배경 컨트롤의 초점 차단, Escape로 닫기와 초점 복귀 확인. 보조 탐색의 원본 버튼이 창을 닫고 근거를 보여주며, 세 화면 폭에서 입력창 접근·가로 넘침을 확인했습니다. JavaScript 오류 없음.
- [파일 내보내기 실패](../verification/review-ux-20261006/browser-export-pending.txt): DB는 7, 문서 파일은 6으로 구분. [복구](../verification/review-ux-20261006/browser-export-recovered.txt)는 이력·revision 증가 없이 수행하고 한 번 undo 후 8에서 원상복구. 스키마 1.10.0, 참조 6,307개·이미지 167개 검증.
- [보존 확인](../verification/review-ux-20261006/preservation.json): 기존 실제 데이터와 ZIP **343개 파일 해시 불변**. 시험 최종 문서는 최초 JSON과 같음. 원래 52741 서버는 보존했고 모든 브라우저 교정은 `verification/browser-data`의 52742 사본에서 수행했습니다.

실제 모델을 호출하거나 새 인증·설치를 수행하지 않았습니다. 이번 검증은 모델의 대화 품질, 원본 이미지 자동 판독, 문서 전체 정확성을 입증하지 않습니다. 기존 표 겹침 경고와 구조 수정 제한은 유지됩니다. 스크린리더의 실제 낭독과 터치 기기 실물 검증은 수행하지 않았습니다.

## 구현과 재현

주요 파일: `web/index.html`, `web/style.css`, `web/conversation.js`, `web/review-layout.js`, `web/app.js`. `candoc/conversation.py`에는 기존 묶음 제안을 재사용하는 사용자 범위 조정과 메시지/결과 표시 정보를 추가했습니다. `candoc/server.py`는 화면 자원과 문서 이름을 제공합니다. 진단 엔진·DoclingDocument 모델·승인 적용 트랜잭션은 재사용합니다.

```powershell
./.venv/Scripts/python -m unittest discover -s tests -v
./.venv/Scripts/python tests/serve_review_ux.py --case final
playwright-cli -s=review-ux open http://127.0.0.1:52742
playwright-cli -s=review-ux run-code --filename=tests/browser-review-ux.js
```

주 흐름 스크립트는 미사용 시험 사본에서 시작합니다. 안전성 시험은 `--case safety-final`과 `tests/browser-review-ux-safety.js`를 사용합니다. 재시작 시험은 `browser-review-ux-prime.js` 후 **시험 서버만** 재시작하고 `browser-review-ux-resume.js`를 실행합니다. 내보내기 실패는 해당 시험 Asset 루트의 `export-fault.json`에 `{"file":"document.json"}`을 지정하고 `browser-review-ux-export.js`를 실행한 뒤, 그 제어 파일을 제거하고 `browser-review-ux-export-recover.js`로 복구합니다. 실제 사용자 데이터에는 이 절차를 사용하지 마세요.
