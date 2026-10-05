# 현재 에이전트 채팅으로 교정하기

서버를 실행한 상태에서 프로젝트 루트의 명령을 사용합니다. 다른 포트면 `candoc.cli --url http://127.0.0.1:52743 get ...`처럼 지정합니다. 명령 결과는 UTF-8 JSON입니다.

```powershell
./.venv/Scripts/python -m candoc.cli status
./.venv/Scripts/python -m candoc.cli suspects
./.venv/Scripts/python -m candoc.cli search 'reactive power'
./.venv/Scripts/python -m candoc.cli get '#/texts/69'
./.venv/Scripts/python -m candoc.cli get '#/tables/0' --cell 0
./.venv/Scripts/python -m candoc.cli proposals
./.venv/Scripts/python -m candoc.cli history
./.venv/Scripts/python -m candoc.cli validate
```

`get`은 Asset ID, 현재 revision, 작업 항목, 최초 항목, 검수 상태, 원본 페이지 URI·bbox·TOPLEFT 위치를 반환합니다. 그림/문단/표 모두 같은 self_ref를 사용합니다. 셀은 표 self_ref와 `table_cells`의 0 기반 index를 함께 전달합니다.

## 반드시 지킬 흐름

1. 사용자가 전달한 서버 주소를 CLI `--url`에 사용하고 Asset ID·ref·cell과 현재 revision을 확인합니다. 같은 Asset의 시험용 사본이 다른 포트에 있을 수 있으므로 서버 주소도 함께 확인합니다. 문서 전체의 `suspects`에서 먼저 후보를 찾는 흐름도 가능합니다.
2. 구조·문자열에서 확인한 사실과 원본 판독이 필요한 추정을 분리합니다. 원본 캡처는 사용자가 확인하도록 안내합니다. 이 MVP는 원본 이미지 OCR을 다시 실행하거나 자동 정답을 생성하지 않습니다.
3. 의심 이유, 정확한 변경 전후, 검증이 남은 부분을 설명합니다. 불명확하면 추측해서 값을 채우지 말고 보류를 제안합니다.
4. 아래 JSON 파일을 만들고 `propose`로 제출합니다. 이것만으로 문서는 바뀌지 않습니다.
5. 사용자가 검수 화면의 제안을 확인하고 승인합니다. CLI는 승인·되돌림 명령을 제공하지 않습니다. 에이전트가 승인 API/UI를 대신 누르거나 DB·작업 JSON을 직접 바꾸지 않습니다. 별도 시험용 사본의 명시적 테스트는 예외입니다.
6. 승인 뒤 `get`·`validate`로 결과를 확인합니다. stale revision은 최신 항목을 다시 조회하고 새 제안으로 제출합니다. 과거 승인을 새 변경에 재사용하지 않습니다.

예시 파일 `proposal.json` — **아래 값은 형식 예시이며 실제 교정 지시가 아닙니다.** `revision`은 get의 현재 값으로, value는 사용자가 판단할 정확한 수정안으로 바꾸세요.

```json
{
  "asset_id": "ieee1547-bc2986e06854",
  "revision": 0,
  "ref": "#/texts/69",
  "op": "text",
  "value": "여기에 원본 근거를 확인할 정확한 수정안",
  "reason": "의심 근거, 수정 이유, 원본 확인이 필요한 부분"
}
```

```powershell
./.venv/Scripts/python -m candoc.cli propose proposal.json
```

| op | 필수 추가 필드 | 효과 |
|---|---|---|
| `text` | `value`: 문자열 | 단일 prov의 leaf TextItem text 수정 |
| `type` | `value`: 지원 label, section_header면 `level`: 1~6 | leaf 텍스트 유형 변경 |
| `cell` | `cell`: 0 기반 index, `value`: 문자열 | 일반 표 셀 내용만 수정 |
| `keep` | `reason`, 셀 단위면 `cell` | 지정 항목/셀 유지 판단 |
| `defer` | `reason`, 셀 단위면 `cell` | 지정 항목/셀 보류 판단 |

모든 제안은 `asset_id`, `revision`, `ref`, `op`, 비어 있지 않은 `reason`이 필요합니다. split/merge/delete/reorder, 참조·bbox·표 구조의 임의 JSON patch는 받지 않습니다.

검수 상태는 `unreviewed`(미확인, 저장 기록 없음), `corrected_partial`(지정 부분 교정), `kept`(명시적인 유지), `deferred`(보류)입니다. 셀 교정으로 표 전체의 과거 유지 판단은 무효화합니다. 다른 셀을 자동 검수 완료로 바꾸지 않습니다. undo는 이전 내용과 상태를 복구하고 되돌림 자체도 이력에 남깁니다.

로컬 API는 브라우저와 CLI의 공통 연결입니다. 읽기 경로는 `/api/bootstrap`, `/api/item?ref=...&cell=...`, `/api/page?page=...`, `/api/suspects`, `/api/history`, `/api/validate`; 제안은 `POST /api/propose`입니다. 쓰기에는 bootstrap 세션 토큰 헤더가 필요합니다. 이는 로컬 요청 보호이며 사람의 신원을 증명하는 인증 체계는 아닙니다.
