# CanDoc MVP 1

DoclingDocument의 의심 항목을 원본 페이지 이미지와 비교하고, 현재 에이전트 채팅에서 만든 교정 제안을 사용자가 승인하는 로컬 검수 도구입니다. 요약·윤문·재배열이나 PDF 재변환을 하지 않습니다.

## 실행

Windows PowerShell, Python 3.13을 권장합니다. 이 PC에서는 Python 3.13.5로 검증했습니다.

```powershell
cd C:/Projects/candoc-v0
./start.ps1
```

브라우저에서 **http://127.0.0.1:52741** 을 엽니다. 터미널을 유지하고 종료할 때 `Ctrl+C`를 누릅니다. 최초 실행은 `.venv`와 Asset을 준비합니다. 의존성 다운로드 외에는 인터넷, 인증, Docker, 변환 서버, 유료 API가 필요하지 않습니다. 포트 변경: `./start.ps1 -Port 52743`.

수동 준비가 필요한 경우:

```powershell
python -m venv .venv
./.venv/Scripts/python -m pip install -r requirements-lock.txt
./.venv/Scripts/python -m candoc.cli init
./.venv/Scripts/python -m candoc.server
```

`init`은 이미 초기화된 Asset을 덮어쓰지 않습니다. `requirements.txt`는 핵심 고정 의존성, `requirements-lock.txt`는 검증 당시 전체 설치 버전입니다.

## 사용 순서

1. **실행**: `./start.ps1`.
2. **문서 열기**: 위 주소에서 1~138페이지를 이동하거나 전체 문서를 검색합니다. 화면에는 현재 페이지와 해당 항목만 올라옵니다.
3. **항목 선택**: 문단·표·그림을 누르면 주황색 원본 영역과 확대 캡처가 나옵니다. 표 셀은 직접 클릭하거나 오른쪽 셀 목록으로 선택합니다. 여러 원본 위치가 있으면 위치 목록으로 전환합니다.
4. **에이전트에게 교정 요청**: `에이전트 요청 복사`를 눌러 현재 채팅에 붙여넣고, 의심 이유나 원하는 수정 내용을 덧붙입니다. 복사가 막히면 아래 요청 텍스트를 직접 복사합니다. 에이전트는 [명령 지침](docs/AGENT.md)을 따라 조회·제안합니다.
5. **결과 확인**: 상단 `제안`에서 원본과 변경 전후를 확인하고 `이 제안 승인·적용`을 누릅니다. 저장 후 새로고침해 결과를 확인합니다. `변경 이력 → 마지막 적용 되돌리기`로 역순 복구할 수 있습니다.

`의심 후보`는 구조·내용 규칙이 찾은 확인 대상입니다. 자동 오류 판정이나 원본 OCR 대조 결과가 아닙니다. `유지 제안`·`보류 제안`도 사용자의 명시적인 승인 후 저장됩니다. 미확인은 기본 상태이고, 텍스트나 셀 하나를 고쳤다고 항목 전체/문서 전체를 검수 완료로 바꾸지 않습니다.

## 데이터 위치

| 경로 | 역할 |
|---|---|
| `IEEE-1547-2018-document-assets.zip` | 제공된 원본 ZIP, 변경하지 않음 |
| `config/conversion-environments.json` | Asset보다 상위의 사용자 제공 변환 환경 정의 |
| `data/manifest.json` | Asset ID, 환경 ID, 스키마 1.10.0, 원본 파일 SHA-256 |
| `data/source/document.json`, `data/source/artifacts/` | 최초 JSON, 138페이지와 기존 그림 이미지. 앱의 쓰기 대상이 아님 |
| `data/source-links.json` | 최초 self_ref와 원본 prov 연결 |
| `data/work/document.json` | 실제 DoclingDocument 형식의 작업 사본 |
| `data/work/artifacts/` | 작업 JSON의 상대 이미지 URI를 유지하는 독립 복사본 |
| `data/work/review.sqlite3` | 확정 문서 revision, 제안, 승인·거절, 검수 상태와 변경 전후 이력 |
| `data/work/review.json` | 별도 검수 상태 내보내기 |

승인은 SQLite 트랜잭션으로 확정하고 `document.json`을 원자 교체합니다. 중단으로 내보내기가 뒤처지면 재실행 시 확정 revision에서 복구합니다. 실행 중 `work/document.json`을 수동 편집하면 재실행 시 덮어써지므로 CLI/API로 제안하세요. 작업을 백업하려면 서버를 종료한 뒤 `data` 폴더를 복사하세요. JSON 다운로드는 문서만 내려받으며 이미지는 `work/artifacts`를 함께 보관해야 합니다.

## 지원 범위와 한계

- 텍스트: 자식이 없고 prov가 하나인 텍스트 항목의 `text`. `orig`는 보존하고 작업 사본 charspan만 새 길이에 맞춥니다.
- 유형: 자식 없는 `text`, `paragraph`, `title`, `section_header`, `page_header`, `page_footer` 사이의 변경. 제목 단계는 명시적으로 지정합니다. `content_layer`는 별도 의미이므로 보존합니다.
- 표: 기존 `table_cells`의 일반 셀 `text` 교정. 0부터 시작하는 **셀 배열 index**로 식별합니다. 행·열 번호와 다릅니다.
- 분리·병합·삭제·재배치·참조 변경, 표 행열/병합 구조, 목록/수식/캡션으로의 유형 전환, 여러 prov의 텍스트 수정, rich cell 수정은 거부합니다. 이 때문에 최초 참조와 위치 연결을 잃지 않습니다.
- 표 셀 자체에는 page_no가 없습니다. 여러 prov의 표에서는 셀의 페이지를 추정하지 않고 표 전체 위치만 제공합니다.
- 실제 입력의 `#/tables/56`에는 셀 범위 겹침이 있습니다. 보존하고 의심 후보로 표시합니다. 공식 HTML 격자가 모든 겹친 셀을 표현할 수 없으므로 셀 목록/JSON으로 확인하며 구조 교정은 보류해야 합니다.
- 공식 HTML은 항목 단위 표시용입니다. 캡션은 별도 항목으로 선택되며, 배열 원본/문서 읽기 순서를 연결해 표시합니다. JSON이 교정 데이터의 기준입니다.
- 로컬 단일 사용자 도구이며 계정 인증을 제공하지 않습니다. 루프백 바인딩·Host/Origin·세션 토큰으로 다른 웹사이트의 쓰기를 차단하지만, 같은 PC의 프로세스가 사용자 승인을 대신하지 않는다는 운영 규칙이 필요합니다.
- 원본 PDF가 없어 원본 전체와의 일치나 변환 정확성은 검증하지 않았습니다. 모든 항목을 사람이 검수한 상태도 아닙니다.

## 검증과 문서

- [Asset·고정 스키마 조사](docs/SCHEMA.md)
- [에이전트 명령과 승인 규칙](docs/AGENT.md)
- [실제 검증 결과](docs/VERIFICATION.md)

```powershell
./.venv/Scripts/python -m unittest discover -s tests -v
./.venv/Scripts/python -m candoc.cli validate
```

브라우저 회귀 스크립트는 `tests/browser-workflow.js`, `tests/browser-decisions.js`입니다. **시험 전용 Asset**을 52742 포트로 실행한 후 `playwright-cli -s=candoc-test run-code --filename=tests/browser-workflow.js`로 실행합니다. 이 스크립트는 시험용 사본에 승인·수정·되돌림을 실제 수행합니다.
