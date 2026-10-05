# 현재 에이전트 채팅으로 교정하기

내장 Codex 대화는 [별도 연결 안내](CODEX-CHAT.md)를 따릅니다. 내장 실행기는 선택된 대상 조회와 pending 제안 생성만 중개하며 아래 CLI나 승인 API를 실행할 권한을 받지 않습니다. 아래 문서는 사용자가 별도로 사용하는 외부 에이전트/CLI 경로입니다.

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
5. 사용자가 검수 화면의 제안을 확인하고 승인합니다. CLI는 승인·되돌림 명령을 제공하지 않습니다. 에이전트가 승인 API/UI를 대신 누르거나 DB·작업 JSON을 직접 바꾸지 않습니다. 별도 시험용 사본의 명시적 테스트는 예외입니다.
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
