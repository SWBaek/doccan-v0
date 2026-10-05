# 일괄 검수

문서를 열면 전체 페이지의 규칙 진단을 백그라운드로 시작합니다. **문제 묶음 선택 → 대표/개별 원본 확인 → 모든 대상 펼치기 → 예외 체크 해제 → 수정안·유지·보류 미리보기 → 정확한 목록 승인 → 다음 문제** 순서입니다. `문서 보기`에서 기존 검색·개별 교정·Codex 대화를 계속 사용합니다. 선택한 문제 묶음은 현재 항목의 채팅 맥락에도 연결됩니다.

[검수 화면](../verification/batch-20261006/overview-desktop.png) · [1366px 화면](../verification/batch-20261006/overview.png) · [승인 직전](../verification/batch-20261006/approval.png) · [충돌 안내](../verification/batch-20261006/conflict.png) · [표 검수](../verification/batch-20261006/table-review.png)

## 실제 138페이지 자료에서 발견한 후보

제공된 원본 ZIP으로 초기화한 격리 Asset의 실제 텍스트·좌표·참조를 CLI/API로 진단했습니다. 시험 교정을 모두 되돌린 문서는 시작 스냅샷과 동일합니다. 기존 52741 서버는 연결을 응답 없이 종료했으며, 해당 서버나 사용자 작업 DB를 재시작/편집하지 않았습니다. 아래는 원본 Asset 사본의 규칙 후보이지 이미지 자동 판독이나 실제 탐지 정확도 평가가 아닙니다.

| 묶음 | 영향 대상 | 근거와 제안 |
|---|---:|---|
| `IEEE Std 1547-2018` | 57개, 18–137쪽 | 구조 필터를 통과한 103개 페이지의 같은 상단 위치(높이의 4.75–4.76%). 46개는 이미 page_header, 57개는 section_header/body. page_header/furniture로 재분류하고 level 제거 제안. 대표 `#/texts/158`, 18쪽. |
| 긴 IEEE 표준명과 유사 변형 | 42개, 18–129쪽 | 117회 반복 중 기존 헤더 75개. 상단 4.75–5.91%에서 동일/유사 문구. 절 제목·본문으로 분류된 42개를 헤더로 제안. 대표 `#/texts/159`, 18쪽. 실제 변형별 페이지 목록도 제공. |
| `Systems Interfaces` | 1개, 43쪽 | 4개 페이지의 동일 문구·상단 7.08%; 나머지 3개는 헤더. `#/texts/684`의 text/body → page_header/furniture 제안. 텍스트를 다른 항목과 합치지 않음. |
| 표 셀 범위 겹침 | 1개, 86쪽 | `#/tables/56`의 셀 배열 index 72와 73이 0 기반 행 20·열 0을 함께 차지. 구조 수정안을 만들지 않고 원본/셀 목록 검수 요청. |
| 제목 번호 깊이와 level 차이 | 44개, 39–95쪽 | 예: `#/texts/632`, `5.3.2`의 번호 깊이 3, 저장 level 4. 번호 체계가 실제 계층인지 확인해야 하므로 level 수정안을 자동 생성하지 않음. |

총 **5개 묶음 / 145개 대상**이며, 그중 재분류 후보 100개, 검수 요청만 45개입니다. 실제 자료에서 재분류할 푸터 후보는 나오지 않았습니다. 푸터/페이지 번호/홀짝/장별 반복은 별도 합성 회귀로 검증했습니다. 숫자를 제외한 문구가 비슷하다는 이유만으로 실제 오류로 확정하지 않습니다.

원시 진단 근거는 [diagnostics.json](../verification/batch-20261006/diagnostics.json)에 있습니다. 최초 텍스트는 검증된 원문이 아니며, 실제 이미지 확인과 최종 판단은 사용자 몫입니다.

## 진단·승인 계약

- `diagnostics.py`: 페이지 상대 좌표와 선언된 좌표 원점, 반복 페이지 수·빈도, 숫자 변형, 문구 유사성, 홀짝 분포, 현재 label, 내부 본문/표, 표 영역 겹침·캡션/각주 참조를 사용합니다. 실제 제목·주의문·번호 붙은 각주는 보수적으로 제외합니다. 장별/문구 변형은 변형별 페이지 목록으로 드러납니다. 임계값은 경험 규칙이며 정확도 확률이 아닙니다.
- `batch.py`: 진단 스냅샷, 안정된 패턴 ID, 대상별 판단과 버전을 DoclingDocument 밖 SQLite에 보관합니다. 취소/실패/서버 중단은 이전 완료 결과를 지우지 않습니다. 진단 도중 다른 수정이 생기면 대상별 충돌 검사에 걸립니다. 재진단은 유지·보류를 보존하고, 처리한 항목이 달라지면 이유와 함께 재검수를 요구합니다.
- 지원 재분류는 leaf TextItem의 label/content_layer/level에 한정합니다. text/orig/prov/charspan/부모/자식/참조는 보존합니다. core 2.93.0, schema 1.10.0의 공식 모델과 추가 참조 검사로 사본을 검증하며 모델 정규화를 저장하지 않습니다.
- 미리보기는 서버가 확정한 전체 before/after와 대상 목록을 갖는 별도 ID입니다. 승인 시 모든 대상의 스냅샷과 적용/검수/되돌림 이력을 다시 검사합니다. 하나라도 충돌하면 전체 무적용입니다. 무조건 최신 revision으로 고쳐 승인하지 않습니다.
- 승인 묶음은 한 DB 트랜잭션·한 revision·한 되돌림 단위입니다. 중간 DB 실패는 롤백합니다. JSON 내보내기 실패는 **DB 전체 반영 / 파일 미완료**로 표시하고 기존 재내보내기 기능으로 복구합니다. 응답 유실 시 같은 ID의 결과를 먼저 조회하며 재승인하지 않습니다.
- 묶음 판단에는 `individually_reviewed=false`를 기록합니다. 대표 사례 확인을 모든 대상의 개별 원본 검수 완료로 계산하지 않습니다. 적용/유지/보류/미해결/재검수를 구분하며 문서 전체 검증 완료로 표시하지 않습니다.
- 그룹·예외·펼침·스크롤·미리보기 ID는 브라우저에 저장하고 확정 판단은 DB에 저장합니다. 브라우저 저장소를 삭제하거나 다른 브라우저로 이동하면 화면 선택은 이동하지 않지만 DB 판단은 유지됩니다.

## 검증

전체 Python 회귀와 브라우저 시험은 `verification/browser-data/batch-20261006` 또는 임시 Asset만 사용했습니다. 브라우저 서버는 52742에 한정합니다. `tests/serve_batch.py`의 Codex는 기존 synthetic 실행기이며 실제 모델 호출·설치·새 인증은 없었습니다.

- 실제 UI: 57개 중 137쪽 `#/texts/2882`를 제외하고 56개 승인 → 한 revision 저장 → 새로고침/재열기 → 한 번의 되돌림으로 시작 문서와 완전 일치. [flow 결과](../verification/batch-20261006/browser-flow.txt)
- UI 충돌·응답 유실: 승인 직전 외부 교정 시 전체 무적용, 최신 진단 후 새 미리보기, 등록/승인 응답 유실 후 같은 ID 결과 조회, 중복 승인 409, 유지·보류 재진단/새로고침 보존. [safety 결과](../verification/batch-20261006/browser-safety.txt)
- 저장 실패: document.json 내보내기 실패 주입 → DB revision 11 / 파일 revision 10 → 시험 서버 재시작에도 pending → 재내보내기는 revision/이력 증가 없음 → 되돌림. 실제 디스크 고장 실험은 아닙니다. [실패](../verification/batch-20261006/browser-export-pending.txt), [재열기](../verification/batch-20261006/browser-export-reopen.txt), [복구](../verification/batch-20261006/browser-export-recovery.txt)
- 기존 개별 검수 브라우저 flow/races/decisions도 통과: 수동 교정, 대상별 초안, 검색 150개 이후, 선택 응답 순서, 셀·다중 원본 위치, 별도 재제안 승인, 기존 undo를 유지했습니다.
- 요소 BOTTOMLEFT와 셀 TOPLEFT를 독립적으로 검증했습니다. 실제 표 겹침 셀 72의 원본 영역도 UI로 확인했습니다. 공식 스키마·참조 6,307개·이미지 167개·원본 파일 168개 검사가 통과했습니다.
- Python **53개 테스트 통과** (291.904초). 전체 결과: [all-tests.txt](../verification/batch-20261006/all-tests.txt). 정상/오탐, 합성 홀짝·장별·번호 변형, 취소/실패/진단 도중 변경/서버 중단, 중복·ABA 충돌, DB 롤백/파일 복구, 재진단과 기존 채팅/검수 회귀를 포함합니다.

- 브라우저 재열기에서 선택·예외·펼침을 복원했고 스크롤 1000px → 984px를 확인했습니다. [화면 상태 복원 결과](../verification/batch-20261006/browser-final.txt)
- 최종 시험 문서는 시작 문서와 완전히 같고 검수 상태는 비어 있으며 revision 30 내보내기가 완료됐습니다. 실제 ZIP과 기존 사용자 `data`의 343개 파일 해시도 모두 같았습니다. [최종 보존 검증](../verification/batch-20261006/trial-final.json)

재현 명령:

```powershell
./.venv/Scripts/python -m unittest discover -s tests -v
# 별도 터미널. 시험 Asset/52742 전용이며 실제 모델 연결 없음.
./.venv/Scripts/python tests/serve_batch.py
playwright-cli -s=candoc-batch open http://127.0.0.1:52742
playwright-cli -s=candoc-batch run-code --filename=tests/browser-batch-flow.js
playwright-cli -s=candoc-batch run-code --filename=tests/browser-batch-safety.js
```

저장 실패 시험은 **시험 폴더에만** `export-fault.json`을 `{"file":"document.json"}`으로 생성하고 pending 스크립트 → 시험 서버 재시작 → reopen 스크립트 → 해당 파일 제거 → recovery 스크립트 순서로 실행합니다. 기존 서버나 `data`에 이 파일을 만들지 않습니다.

## 남은 한계와 적용

드문 반복·불명확한 원본 위치·복잡한 트리와 구조 변경은 자동 수정 범위 밖입니다. 번호 기반 제목 계층은 실제 편집 규칙과 다를 수 있습니다. 본문 분리/연결이나 표 구조의 정답을 추정하지 않습니다. 이미지 OCR 대조, 누락된 전체 내용 탐지, 실제 문서의 정밀도/재현율 측정, 실제 모델의 의미 판단 품질 평가는 하지 않았습니다. 합성 시험 성공은 문서 정확도가 아닙니다.

기존 서버를 보존했으므로 사용자가 기존 52741 서버를 종료하고 `./start.ps1`로 재시작해야 새 백엔드가 활성화됩니다. Codex 설정을 사용하던 경우 기존 `-ChatConfig`도 유지하세요.
