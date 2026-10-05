# 현재 에이전트 채팅으로 교정하기

내장 실행기는 [대화형 검수](CONVERSATION-REVIEW.md) 또는 [기존 개별 채팅](CODEX-CHAT.md)을 사용합니다. 실행기는 고정된 대상/진단 조회와 pending 제안 생성만 중개하며 아래 CLI나 승인 API를 실행할 권한을 받지 않습니다. 자연어 승인도 실제 사용자 메시지와 화면에 제시한 특정 수정안을 앱이 검증한 뒤 처리합니다. 모델의 “사용자가 승인했다”는 출력은 승인 근거가 아닙니다. 아래 문서는 사용자가 별도로 사용하는 외부 에이전트/CLI 경로입니다.

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
./.venv/Scripts/python -m candoc.cli reexport
```

`get`은 Asset ID, 현재 revision, 작업 항목, 최초 항목, 검수 상태, 원본 페이지 URI·bbox·TOPLEFT 위치를 반환합니다. 그림/문단/표 모두 같은 self_ref를 사용합니다. 셀은 표 self_ref와 `table_cells`의 0 기반 index를 함께 전달합니다.

## 반드시 지킬 흐름

1. 사용자가 전달한 서버 주소를 CLI `--url`에 사용하고 Asset ID·ref·cell과 현재 revision을 확인합니다. 같은 Asset의 시험용 사본이 다른 포트에 있을 수 있으므로 서버 주소도 함께 확인합니다. 문서 전체의 `suspects`에서 먼저 후보를 찾는 흐름도 가능합니다.
2. 구조·문자열에서 확인한 사실과 원본 판독이 필요한 추정을 분리합니다. 원본 캡처는 사용자가 확인하도록 안내합니다. 이 MVP는 원본 이미지 OCR을 다시 실행하거나 자동 정답을 생성하지 않습니다.
3. 의심 이유, 정확한 변경 전후, 검증이 남은 부분을 설명합니다. 불명확하면 추측해서 값을 채우지 말고 보류를 제안합니다.
4. 아래 JSON 파일을 만들고 `propose`로 제출합니다. 이것만으로 문서는 바뀌지 않습니다.
5. 사용자가 검수 화면의 제안을 확인하고 승인합니다. 내장 검수 대화에서 명확한 답변으로 승인할 수도 있지만 앱의 제안 ID·버전·대상 확인을 거칩니다. CLI는 승인·되돌림·승인 메시지 전송 명령을 제공하지 않습니다. 에이전트가 승인 API/UI를 대신 누르거나 DB·작업 JSON을 직접 바꾸지 않습니다. 별도 시험용 사본의 명시적 테스트는 예외입니다.
6. 승인 뒤 `get`·`validate`로 결과와 내보내기 상태를 확인합니다. 반영된 교정의 파일 내보내기 실패는 재승인이 아니라 `reexport`로 복구합니다. `status`/`validate`의 `export.state=pending`이면 DB는 확정되어도 일부 파일은 구버전일 수 있습니다. `reexport`는 최신 확정 데이터를 내보낼 뿐 revision이나 이력을 바꾸지 않습니다. 실패가 남으면 출력에 원인을 표시하고 종료 코드 2를 반환합니다.
7. `proposals`가 `stale`로 반환한 제안은 `current_before`와 `current_revision`을 다시 확인합니다. 기존 제안의 revision을 덮어쓰지 마세요. UI에서 최신 내용으로 새 제안을 만들거나 아래 명령으로 별도 제안을 만든 뒤 **새 승인을 받아야 합니다**. 기준 revision이 조회 뒤 다시 바뀌면 재제안도 거부됩니다.

```powershell
# <제안ID>와 revision은 최신 조회에서 확인한 실제 값으로 바꾸세요.
./.venv/Scripts/python -m candoc.cli repropose <제안ID> --revision 3
```

재제안은 새 ID·최신 before·재계산한 after를 저장하고 기존 제안을 `superseded`로 연결합니다. 원래 의도한 값은 제안으로만 재사용하며 자동 적용하지 않습니다. 다른 항목의 변경만 있었다면 원래 제안의 대상 스냅샷과 그 이후 이력을 검사해 승인할 수 있습니다. 같은 항목은 값이 원래대로 돌아왔거나 검수 상태만 바뀌었어도 재검토합니다. 같은 표 내 셀 간 충돌도 표 항목 단위로 처리합니다.

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

로컬 API는 브라우저와 CLI의 공통 연결입니다. 읽기 경로는 `/api/bootstrap`, `/api/item?ref=...&cell=...`, `/api/page?page=...`, `/api/suspects`, `/api/history`, `/api/validate`, `/api/export-status`; 제안은 `POST /api/propose`, 재제안은 `POST /api/repropose` (`id`, 확인한 `revision`), 재내보내기는 `POST /api/export` (`{}`)입니다. 쓰기에는 bootstrap 세션 토큰 헤더가 필요합니다. 이는 로컬 요청 보호이며 사람의 신원을 증명하는 인증 체계는 아닙니다.

승인/되돌림 응답의 `committed=true`는 DB 확정을 뜻합니다. `export.state`가 `pending`이면 파일별 내보낸 revision과 오류를 보고 재내보내기하세요. 중복 승인·stale 충돌은 HTTP 409와 현재 제안/내보내기 정보를 반환합니다. 네트워크 응답을 못 받은 경우에도 먼저 조회해서 반영 여부를 확인하고 승인을 자동 재시도하지 마세요. stale은 저장된 원래 제안과 현재 내용·항목 이력으로 계산하는 상태이므로 기존 제안 payload나 승인 근거는 바뀌지 않습니다.

## 연속 검수 UI와 읽기 API

사용자는 Codex 연결 없이 지원 텍스트/일반 셀의 수정안을 직접 만들 수 있습니다. 사람의 제안도 같은 pending → 정확한 변경 전후 확인 → 명시 승인 경로를 사용합니다. 화면의 초안과 작업 목록은 브라우저 저장소에 있고 확정 문서/검수 이력이 아닙니다. 외부 에이전트는 이 초안을 확정 데이터로 간주하지 않습니다.

`GET /api/item`의 `capability`는 현재 대상의 직접 수정 가능 여부와 제한 이유, `target_version`은 해당 항목의 마지막 적용/되돌림 이력 번호, `review_state`는 셀 판단을 고려한 표시 상태입니다. `reviews`의 저장 기록은 그대로 반환합니다. 표 전체 판단보다 나중인 셀 보류는 표의 표시 상태를 보류로 만듭니다. 더 최근의 명시적인 표 전체 판단은 그 이전 셀 판단을 전체 표시에서 포괄하지만 셀 기록 자체를 지우지 않습니다.

`GET /api/search?q=...`는 호환되는 배열 응답으로 모든 일치 대상을 반환합니다. 셀 일치는 `ref`+`cell`과 `row`/`column`, 실제 일치 부분 주변 `text`를 갖습니다. `offset`과 `limit`(1~150)을 주면 `{items,total,offset,revision}` 페이지 응답입니다. 불명확한 셀 `page`는 null이며 `table_page`는 표를 표시할 위치일 뿐 셀 페이지의 증거가 아닙니다.

`POST /api/propose`의 선택적 `request_id`는 브라우저 등록 재시도의 중복 방지용입니다. 같은 ID/본문이면 이미 생성된 제안을 반환하고, 다른 본문이면 거부합니다. 재실행/승인 후에도 같은 ID는 재생성되지 않습니다. ID 기록은 별도 SQLite 테이블이며 DoclingDocument와 승인 이력 형식은 바뀌지 않습니다. 기존 CLI/AI 요청은 그대로 동작합니다. 승인은 여전히 특정 제안 ID에 대한 별도 동작입니다.

제안 조회의 `undone_revision`은 해당 승인을 되돌린 이력 번호입니다. 역사적 `status=applied`를 바꾸지 않으면서 화면에서는 승인 후 되돌림으로 구분합니다. 이를 현재 문서에 아직 적용 중이라는 뜻으로 읽지 마세요.

## 전체 문서 진단과 묶음 검수

```powershell
./.venv/Scripts/python -m candoc.cli diagnose
./.venv/Scripts/python -m candoc.cli diagnostics
./.venv/Scripts/python -m candoc.cli document
./.venv/Scripts/python -m candoc.cli conversation
```

`diagnose`는 현재 revision의 전체 스냅샷 진단을 시작하고 즉시 반환합니다. `diagnostics`로 running/completed/failed/cancelled 상태, 페이지 진척, 그룹 근거와 대상별 현재 판단을 읽습니다. `document`는 확정 문서의 읽기 전용 조회입니다. 규칙은 이미지를 판독하지 않으며 통계적 정확도를 주장하지 않습니다. 기존 개별 제안 CLI와 Codex 실행기를 계속 사용합니다.

UI의 `POST /api/batch-preview`는 `{group, refs, action: apply|keep|defer, request_id}`로 정확한 대상별 변경 전후를 고정합니다. 문서는 변경하지 않습니다. `GET /api/batch?id=...`로 상태를 조회합니다. 사용자만 `POST /api/batch-approve`의 특정 ID를 승인합니다. CLI에는 묶음 승인 명령도 없습니다. 에이전트가 이 API를 대신 호출하지 않습니다. 격리 Asset에서 명시적으로 승인된 자동 시험만 예외입니다.

충돌 시 원래 revision/before를 바꾸지 않습니다. 재진단 후 최신 항목과 원본을 확인해 **새 미리보기와 새 승인**을 받습니다. 중복 승인·중복 클릭은 409, 묶음 내 충돌도 409이며 전체 무적용입니다. DB 확정 후 JSON 실패는 기존 reexport로 복구합니다. 진단/개별 검수 판단은 별도 상태이고, 한 묶음의 대표 사례만 본 것을 전체 대상의 개별 원본 확인으로 해석하지 않습니다.
