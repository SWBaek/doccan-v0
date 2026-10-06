# 검수 화면의 Codex 대화

CanDoc의 Python 서버가 해당 PC에 설치된 공식 Codex app-server를 stdio 자식 프로세스로 실행한다. 모델 API를 직접 호출하지 않는다. Paseo 설치·세션·경로는 제품에 필요하지 않다.

현재 기본 화면은 [에이전트 주도 검수 대화](CONVERSATION-REVIEW.md)다. 아래 개별 항목 채팅은 기존 기록과 인터페이스를 유지한다. 기본 대화는 공식 `model/list`에서 모델/effort를 조회하고 매 `turn/start`에 선택값을 명시한다. 모델별 지원 조합을 검증하며 목록 실패 시 대체하지 않는다.

## 다른 PC에서 설치·실행

1. Python 3.13과 **Codex CLI**를 설치한다. 공식 CLI 설치 경로를 사용하고 `codex --version`으로 설치를 확인한다. 버전 번호에 따른 연결 제한은 없다. 실제 실행 검증 기준은 0.160.0이며, 다른 버전도 연결 시 필요한 프로토콜·권한 검사를 통과해야 한다.
2. 그 PC의 터미널에서 `codex login`으로 사용자가 ChatGPT에 정상 로그인한다. 이미 로그인돼 있으면 다시 로그인할 필요가 없다. CanDoc은 로그인/OAuth를 시작하지 않고, 인증 파일을 읽거나 복사하지 않는다. API 키 로그인은 거부한다.
3. 프로젝트 코드와 입력 ZIP을 원하는 폴더에 복사한다. 기존 교정 데이터도 옮기려면 원래 서버를 사용자가 종료한 뒤 `data` 전체를 함께 복사한다. `.venv`, Codex 인증 파일, `.candoc-chat`은 복사 대상이 아니다. 새 PC에서 가상 환경을 만든다.
4. `config/codex.example.json`을 필요하면 `config/codex.local.json`으로 복사하여 경로를 바꾼다. 상대 경로는 설정 파일 위치를 기준으로 해석한다.

```json
{
  "codex_executable": "codex",
  "project_dir": "..",
  "state_dir": "../.candoc-chat",
  "model": null
}
```

`codex_executable`은 PATH의 실행 파일 이름 또는 실제 실행 파일 경로다. Windows에서는 `codex.exe`를 권장한다. npm shim만 발견되면 해당 패키지 안의 유일한 native `codex.exe`를 찾으며, 찾을 수 없으면 명시적 경로를 요구한다. 셸 문자열을 실행하지 않는다. `project_dir`는 Codex 설정을 해석할 프로젝트 위치다. `state_dir`는 CanDoc 대화 기록 위치이며 Asset 경로별로 구분된다. `model: null`은 사용자 Codex 설정의 모델을 사용한다. 모델 이름을 지정할 수도 있지만 해당 계정의 모델 접근 가능 여부는 실제 대화 전까지 확인되지 않는다.

```powershell
# 프로젝트 폴더에서
./start.ps1 -ChatConfig ./config/codex.example.json
# Asset 경로와 포트를 바꾸는 경우
./start.ps1 -Data 'D:/review/ieee1547' -Port 52743 -ChatConfig ./config/codex.local.json
```

PowerShell 스크립트 없이 실행하는 경우:

```sh
python -m venv .venv
# Windows: .venv/Scripts/python / macOS·Linux: .venv/bin/python
.venv/bin/python -m pip install -r requirements-lock.txt
.venv/bin/python -m candoc.cli init --zip /path/to/document-assets.zip --data /path/to/asset
.venv/bin/python -m candoc.server --data /path/to/asset --port 52741 --chat-config /path/to/codex.local.json
```

이 PC에서는 Windows/Python 3.13.5/Codex 0.160.0으로 검증했다. 다른 PC·macOS·Linux의 실제 실행은 미검증이다. 코드와 예시에는 이 PC의 사용자 경로나 Paseo 세션 ID가 필요하지 않다.

## 기존 개별 항목 채팅의 사용과 상태

- `개별 항목 채팅`을 열어 `연결·재개`를 누른다. 연결 단계는 로그인 상태·권한 설정·저장된 thread를 확인하며 사용자 메시지를 보내지 않는다.
- 문단·항목·표 셀을 선택하고 `다음 메시지 대상`의 ID와 revision을 확인한 뒤 보낸다. 메시지마다 고정한 대상도 기록에 표시한다. 이후 선택을 바꿔도 진행 중인 요청의 대상은 바뀌지 않는다.
- 응답은 SSE로 점진 표시한다. 전송 중/답변 중/중단 중/완료/오류/중단 상태를 구별한다. `중단`은 공식 `turn/interrupt`를 사용하며 완료 통지가 오지 않으면 소유한 프로세스를 종료한다.
- `제안 확인`에서 기존 승인 화면을 연다. 대화에서 만들어진 것은 pending 제안이다. 원본 영역과 변경 전후를 확인하고 사용자가 승인해야 DB와 문서가 바뀐다.
- `연결 종료`는 CanDoc이 시작한 app-server와 자식 프로세스만 종료한다. 브라우저 새로고침은 대화를 종료하지 않는다. CanDoc 서버 종료 때도 실행기를 정리한다.
- 메시지 ID는 전송 전에 생성한다. HTTP 응답이 불확실하면 같은 ID로 결과를 조회·재시도하며 이미 접수한 요청을 다시 실행하지 않는다. 자동 모델 재전송은 없다. 서버 재시작 중이던 요청은 중단으로 표시한다.
- 재연결은 저장된 `thread.id`로 `thread/resume`한다. 첫 메시지 이전의 빈 thread는 Codex에 rollout이 없을 수 있어 **로컬 메시지가 0건인 경우에만** 새로 만든다. 메시지를 보낸 대화의 기록이 없으면 오류로 멈추며 임의로 다른 대화로 대체하지 않는다.
- 대화 재개에는 그 PC/사용자의 Codex thread 저장소가 필요하다. `.candoc-chat`만 다른 PC로 옮겨도 Codex 대화가 이동하지 않는다. 다른 PC에서는 새 대화 저장 폴더로 시작한다.

## 데이터와 권한 경계

기존 개별 채팅의 문서 도구는 `candoc_read_selection`과 `candoc_propose_correction`이다. 기본 검수 대화에는 같은 broker에 `candoc_review_read`와 `candoc_review_prepare`를 추가한다. 후자는 고정된 진단 묶음의 읽기와 불변 pending 제안 생성만 수행하며 예외 ref가 묶음 범위에 속하는지 검사한다. 모델이 Asset/revision 또는 개별 제안의 ref/cell을 임의 지정할 수 없다. 다른 thread/turn의 호출, 지원하지 않는 인수, 셀 대화에서의 표 전체 수정, stale revision을 거부한다. 도구에는 승인·거절·되돌림·내보내기·파일·셸·임의 HTTP API가 없다. API 세션 토큰과 서버 주소도 모델 맥락에 넣지 않는다.

공식 실행기 기능으로 다음을 적용한다.

1. `thread/start`와 **매 `turn/start`에 `environments: []`**를 지정하여 실행 환경을 주지 않는다. 같은 버전의 공식 구현은 환경이 없으면 셸·apply_patch·로컬 이미지 도구를 등록하지 않는다. `read-only`, 승인 정책 `never`, reviewer `user`도 명시하고 thread 응답의 실제 정책을 확인한다.
2. 앱/플러그인/MCP/브라우저/컴퓨터 조작/하위 에이전트/훅/메모리/셸을 비활성화한다. 첫 프로세스는 설정과 로그인 상태만 조회하고 종료한다. 상속된 MCP 이름을 알아낸 뒤 두 번째 프로세스에서 모두 비활성화한다. 실제 설정과 `mcpServerStatus/list`에서 비활성 상태·도구 없음까지 재확인한 뒤 연결을 허용한다. 사용자 설정 파일은 수정하지 않는다.
3. 사용자 스킬 카탈로그를 자동 맥락에 넣지 않는다. 부모 실행 환경의 Paseo 변수와 Codex 세션 변수를 제거한다. 사용자 Codex 홈 위치 설정은 유지하고 인증 처리는 Codex에 맡긴다.
4. 일부 모델은 공식 V8 중개 도구 `functions.exec/wait`와 시계 유틸리티를 사용한다. 이는 OS 셸이 아니며 Node/파일시스템/네트워크 접근이 없다. 문서에 접근하는 중첩 도구는 위 broker 도구뿐이다. 별도 사용자 입력·권한·로그인·승인 요청은 앱이 거부한다. `code_mode_host`는 이 중개 경로가 필요한 모델을 위해 켜며, 그 환경에서 `require/process/fetch`와 셸 도구가 없는 것을 실제 실행기로 확인했다.
5. 실제 권한 설정 불일치, 활성 MCP 잔존, 비정상 실행 이벤트가 있으면 연결을 차단한다. 버전 번호만으로 연결을 차단하지 않는다. 브라우저에는 임의 JSON-RPC 중계 기능을 제공하지 않는다. 출력은 HTML이 아닌 텍스트로 표시한다.

프롬프트는 교정 목적과 불확실성을 설명할 뿐 권한 경계로 취급하지 않는다. 이 설계는 설치된 공식 Codex와 로컬 사용자/OS를 신뢰한다. app-server 자체의 인증·대화 기록 쓰기까지 OS 전체에서 격리한 것은 아니며, 같은 OS 사용자의 다른 프로그램을 차단하는 인증 체계도 아니다. Windows에서는 소유한 프로세스 트리를 Job Object로 묶어 부모가 먼저 죽어도 자식을 정리한다. macOS/Linux에는 별도 프로세스 그룹을 사용하지만 실제 플랫폼 검증은 남아 있다.

외부로 보내는 맥락은 메시지와 선택한 대상의 ID/revision/텍스트/초기 변환 텍스트/위치 정보다. 셀 선택 때는 표 전체가 아니라 해당 셀만 보낸다. 항목 미선택 시 문서 이름·스키마·페이지 수만 보낸다. 원본 이미지·ZIP·문서 전체·로컬 파일 경로를 도구 응답에 넣지 않는다. 선택 맥락은 16,000자, 사용자 메시지는 8,000자로 제한한다. `original_text`는 최초 **변환 결과**이며 PDF 원문을 검증한 값이 아니다.

CanDoc은 별도 `chat.sqlite3`에 thread/session ID, 전송 대상, 대화 내용, 상태와 중복 방지 정보를 저장한다. Codex도 자신의 일반 대화 저장소를 사용한다. 대화에는 선택한 문서 텍스트가 있으므로 공유할 때 원본 데이터와 함께 취급한다. 인증 토큰/키를 이 DB에 저장하지 않는다.

## 프로토콜과 검증 근거

공식 [app-server 문서](https://developers.openai.com/codex/app-server), [설정 참조](https://developers.openai.com/codex/config-reference), 설치된 `codex --version`/`app-server --help` 및 다음 명령의 실제 출력에 맞췄다.

```sh
codex app-server --listen stdio://
codex app-server generate-json-schema --experimental --out ./protocol
```

통신은 `jsonrpc` 헤더 없는 JSONL이다. `initialize` → `initialized`, `account/read`, `config/read`, `thread/start`/`thread/resume`, `mcpServerStatus/list`, `turn/start`/`turn/interrupt`와 `item/agentMessage/delta`, `item/completed`, `turn/completed`, `item/tool/call`을 사용한다. dynamic tools는 experimental API opt-in 대상이다. 실제 생성한 스키마의 필요한 부분을 `tests/fixtures/codex-0.160.0.json`에 보관하고 송신 요청을 검증한다. 필수 권한 게이트는 동일 태그 `rust-v0.160.0`의 [도구 등록 구현 사본](../verification/chat-20261006/upstream/spec_plan.rs)에서도 확인했다.

기존 연결·격리 검증은 [구현 검증 기록](CHAT-VERIFICATION.md), 이후 사용자 승인 아래 수행한 실제 모델 3턴과 대화형 승인 검증은 [대화형 검수 기록](CONVERSATION-REVIEW.md)에 정리한다. 이 제한된 시험으로 모든 문서/모델의 대화 품질을 보장하지 않는다.

## 연속 검수 화면

대화는 변환 영역 아래에 열려 원본과 제안 승인 영역을 덮지 않습니다. 미전송 메시지는 선택한 항목/셀의 초안에 보관합니다. 다른 대상을 선택하면 해당 대상의 초안을 보여 주고, 전송된 메시지는 원래 대상을 유지합니다. 선택을 읽는 동안 전송을 막습니다. 초안 기준이 바뀌면 원본 옆 경고에서 이전 기준을 확인하고 계속할 수 있습니다. **AI는 원본 이미지를 보지 않습니다.**

`제안 확인`은 원본 옆 검토 패널을 엽니다. 사람의 직접 수정 제안과 AI 제안은 같은 검토·승인·이력 경로를 사용합니다. 자세한 재개/초안 제한은 [연속 검수 안내](CONTINUOUS-REVIEW.md)를 참고하세요.

문제 묶음에서 선택한 항목은 전송 시 해당 묶음 ID·제목·의심 이유·선택 항목의 계산 근거와 함께 고정됩니다. 서버가 묶음 소속을 확인합니다. 묶음은 규칙 후보이며 원문으로 검증된 사실이 아닙니다. 원본 이미지는 여전히 모델에 전송하지 않습니다. 기존 도구의 제안 권한은 선택한 한 항목에 제한되며, 묶음 승인이나 다른 항목으로의 권한 확장은 없습니다.
