# Codex 대화 구현 검증 기록

검증일: 2026-10-06. Windows, Python 3.13.5, 공식 Codex CLI 0.160.0. 설치·실행·권한 설계는 [CODEX-CHAT.md](CODEX-CHAT.md)를 따른다.

## 변경 파일

| 파일 | 변경 내용 |
|---|---|
| `candoc/codex_rpc.py` (신규) | 버전 확인, 공식 stdio JSONL, 자식 환경·권한 설정, Windows Job Object 및 프로세스 종료 |
| `candoc/chat.py` (신규) | 선택 고정, 최소 문맥, 대화 저널·중복 방지, 재개·중단, 조회·pending 제안 중개 |
| `candoc/server.py` | 선택적 채팅 설정, 제한된 API·SSE, 서버 종료 시 실행기 정리 |
| `web/chat.js` (신규), `web/app.js`, `web/index.html`, `web/style.css` | 채팅 패널, 스트리밍·상태·복구, 메시지별 대상 표시, 기존 승인 화면 연결 |
| `start.ps1`, `config/codex.example.json` (신규), `.gitignore` | 휴대 가능한 선택적 설정과 로컬 대화 파일 제외 |
| `README.md`, `docs/AGENT.md`, `docs/CHAT-PLAN.md` (신규), `docs/CODEX-CHAT.md` (신규), 이 문서 | 실행법·계획·권한·검증 범위 |
| `tests/test_chat.py`, `tests/fake_codex.py`, `tests/fixtures/codex-0.160.0.json` (신규) | 모의 stdio 회귀 시험과 공식 생성 스키마 검증 |
| `tests/serve_chat.py`, `tests/browser-chat.js`, `tests/browser-chat-reopen.js` (신규) | 격리 Asset에서 실제 UI 시험 |
| `tests/probe_codex_connection.py`, `tests/probe_codex_boundary.py` (신규) | 실제 실행기 연결 및 로컬 합성 응답 권한 시험 |

`candoc/core.py`의 문서 교정·승인 규칙과 기존 테스트 코드는 이번 작업에서 변경하지 않았다. 기존 파일의 변경 전후는 [diff](../verification/chat-20261006/tracked-changes.diff)에 보관했다. 커밋·푸시·배포는 수행하지 않았다.

## 자동·UI 회귀 결과

`./.venv/Scripts/python -m unittest discover -s tests -v`: **37/37 통과**. 기존 17개 + 신규 20개, 246.301초. [전체 로그](../verification/chat-20261006/all-tests.txt)

신규 시험은 연결·로그인 미완료·설정/버전 불일치, 스트리밍·최종 메시지, 선택한 셀의 최소 맥락 고정, 프로세스/앱 재개, 중단·시간 초과·비정상 종료·소유 자식 정리, 전송/도구 중복, 다른 대상/turn 공격, stale 제안, 허용하지 않은 도구, portable 설정과 공식 스키마를 확인했다. 기존 시험은 저장·내보내기 실패 복구, 표 셀 원본 맥락, stale 재제안과 별도 승인 등을 포함한다.

브라우저 시험은 `verification/browser-data/chat-20261006` 사본과 52742 포트의 **모의 Codex**에서 수행했다.

- [대화 흐름](../verification/chat-20261006/browser-chat-first.txt): 완료 전 응답 표시, 셀 변경 후 보낸 메시지의 대상 유지, 중단, 중복 도구에도 제안 1건, 승인 전 문서 불변, 사용자 승인 후 새로고침 유지, 연결 종료·재개, 전송 ID 재사용 시 중복 실행 없음, 오류·프로세스 종료·명시적 복구, 되돌림 통과.
- [서버 재시작](../verification/chat-20261006/browser-chat-reopen.txt): 같은 thread와 기존 4개 실행 복원, 자동 재전송 없음, 재시작 후 새 메시지 완료 통과.
- [기존 표 셀 UI](../verification/chat-20261006/browser-cells.txt): 교정·유지·보류 각각 원본 셀 문맥 → 승인 → 새로고침 → 되돌림 통과. TOPLEFT 셀과 BOTTOMLEFT 표 위치 유지.
- `node --check` 두 UI JS 및 Python `compileall` 통과. 정상 대화 흐름의 브라우저 콘솔 오류는 없었으며, 의도한 서버 재시작 때 열려 있던 SSE에서 연결 reset 1건이 발생한 후 복원됐다.

화면: [스트리밍·제안](../verification/chat-20261006/chat-stream-and-proposal.png), [오류 후 복구](../verification/chat-20261006/chat-recovery.png).

## 실제 Codex와 모델 시험의 구분

| 대상 | 결과와 범위 |
|---|---|
| 실제 설치된 Codex 연결 | **통과**. 현재 PC의 정상 ChatGPT 로그인 상태, initialize/config 검증, thread 생성, 종료·재연결 확인. 메시지는 0건. 인증 파일을 읽거나 복사하지 않았고 새 로그인을 시작하지 않았다. [결과](../verification/chat-20261006/actual-connection.json) |
| 빈 실제 thread의 재개 | 재개 요청을 보내면 첫 메시지 이전 rollout이 없을 수 있음을 확인. 로컬 메시지 0건일 때만 새 thread로 복구한다. 메시지가 있는 대화는 이 예외를 허용하지 않는다. |
| 실제 실행기의 권한·기록 재개 | **통과**. 임시 Codex 홈과 로컬 합성 Responses 서버로 실제 0.160.0 실행기를 구동했다. 셸·apply_patch 요청 거부, 금지 파일 미생성, 설정된 MCP 미기동, V8의 require/process/fetch 없음, 중첩 셸 도구 없음, 선택 조회 성공, 실행기 재시작 후 기록 있는 thread 재개 확인. 외부 모델 호출 없음. [결과](../verification/chat-20261006/actual-boundary.json) |
| 실제 모델 대화 | **미실행**. 유료 모델 호출·계정 모델 접근·실제 응답 품질·사용량은 미검증. 실제 대화를 시험하려면 사용량 발생 가능성과 시험 메시지를 먼저 정해 사용자에게 보고해야 한다. |
| 다른 PC 실행 | **미검증**. PC 고정 경로와 Paseo 제품 의존성을 제거하고 설치 절차를 제공했지만 다른 PC/macOS/Linux에서 실제 실행하지 않았다. |

실제 실행기는 `functions.exec/wait`, 비동기 사용자 입력 같은 중개 표면을 노출할 수 있다. 앱은 사용자 입력/승인/권한 RPC를 거부하며, 실행 권한이 있는 문서 도구는 조회와 pending 제안뿐이다. 모델 권한은 공식 환경·도구 등록과 앱 중개 검증으로 제한하며 프롬프트만으로 보장한다고 주장하지 않는다. 전체 OS 격리나 악성 로컬 프로그램 방어를 검증한 것은 아니다.

개발 중 생성한 `actual-handshake.*`, `chat-tests-first/second/third.txt`, 디버그 로그에는 수정 전 실패가 남아 있다. 최종 판정은 위에 링크한 전체 37개 로그와 `actual-connection.json`, `actual-boundary.json`, UI 결과를 기준으로 한다.

## 보존과 실행 안내

입력 ZIP과 실제 `data`의 **343개 파일 SHA-256이 작업 전과 동일**하다. 실행 중인 원래 서버의 잠금 파일만 제외했다. [보존 결과](../verification/chat-20261006/preservation.json). 실제 교정 JSON/SQLite/WAL/source/artifacts를 포함하며, 원래 52741 서버는 종료하지 않았다. 시험 서버와 이 작업에서 시작한 브라우저·Codex 프로세스만 정리했다.

기존 서버에는 새 Python 코드가 자동 적용되지 않는다. 사용자가 기존 서버를 종료한 뒤 프로젝트 폴더에서 다음과 같이 실행한다. 기존 서버를 유지하려면 다른 Asset과 포트를 지정한다.

```powershell
./start.ps1 -ChatConfig ./config/codex.example.json
```

해당 PC에 Codex CLI와 정상 ChatGPT 로그인이 필요하다. 이 문서의 실제 실행 검증 버전은 **0.160.0**이지만, 현재 코드는 버전 번호만으로 연결을 차단하지 않는다. 경로 변경은 설정 예시를 복사해 지정한다. 사용자는 채팅에서 만든 제안을 기존 승인 화면에서 직접 확인·승인한다.
