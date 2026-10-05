# 에이전트 주도 검수

## 시작

기존 서버를 사용자가 종료한 뒤 프로젝트 폴더에서 실행합니다. 설치·로그인 조건은 [Codex 연결 안내](CODEX-CHAT.md)를 따릅니다.

```powershell
./start.ps1 -ChatConfig ./config/codex.example.json
```

1. `http://127.0.0.1:52741`의 **검수 대화**에서 **Codex 연결·모델 조회**를 누릅니다. 연결/목록 조회는 모델 턴을 보내지 않습니다.
2. **모델과 Reasoning effort를 모두 선택**하고 **검수 시작**을 누릅니다. 시작 버튼도 선택값을 서버에 적용합니다. 실행 중 설정은 잠기고, 일시정지/완료 후 `설정 적용`으로 바꾸면 다음 턴부터 반영됩니다. 각 대화 기록에는 실제 요청 설정이 남습니다.
3. “검수를 시작할게요” 안내와 함께 기존 전체 문서 진단을 실행합니다. 끝나면 첫 묶음의 실제 근거를 Codex에 전달하고 설명/질문/제안을 받습니다. 규칙만으로 생성한 고정 답변을 모델 응답처럼 표시하지 않습니다.
4. 원본 버튼을 눌러 해당 페이지 영역과 현재 내용을 대조합니다. 정확한 전체 대상·변경 전후는 수정안 카드에서 펼쳐 볼 수 있습니다. 대표 확인은 모든 항목의 개별 검수 완료가 아닙니다.
5. 질문, 예외, 판단을 대화로 보냅니다. 승인한 적용을 확인하면 다음 문제를 설명합니다. 보조 `문제 묶음` 목록과 `이전 문제`로 특정 대상을 다시 열 수 있습니다.

예시 흐름:

> 에이전트: 같은 문구가 상단의 일정 위치에 반복됩니다. 57개를 페이지 머리말로 재분류하는 안을 준비했습니다. 원본을 확인한 뒤 변경할까요?
>
> 사용자: 왜 그렇게 생각해?
>
> 에이전트: 위치·반복·기존 분류 근거를 설명하고, 최초 변환 결과만으로 원문 일치를 단정할 수 없다고 안내합니다.
>
> 사용자: 137쪽 항목은 제외해.
>
> 에이전트: 제외한 56개에 대한 새 수정안을 준비합니다.
>
> 사용자: 응.
>
> 앱: 표시된 새 제안에만 승인을 기록하고 기존 검증 경로로 적용합니다. 결과 확인 후 다음 문제로 진행합니다.

`그대로 둬`/`유지해`와 `보류해`는 현재 표시된 정확한 대상의 판단을 기록합니다. 내용은 바꾸지 않으며 기존 검수 상태·이력을 사용합니다. `다음 항목`은 판단 없이 이동하는 명령입니다. 제외는 현재 제안 범위에서만 제외하는 것이며 영구 삭제나 분석 필터가 아닙니다.

## 대상과 승인

- 기본 입력은 **대화의 고정 대상**에 보냅니다. 화면에서 다른 항목을 눌러도 대기 중인 승인 범위는 바뀌지 않습니다.
- `화면에서 선택한 문단·셀에 대해 새 질문`을 선택하면 전송 시 Asset/ref/cell/revision을 새 턴에 고정합니다. 이전 문제의 승인 카드는 현재 대화에서 분리합니다.
- 예외를 가리키는 데 사용할 화면 선택도 전송 시 별도로 고정됩니다. 이후 선택 이동은 전달된 맥락에 영향을 주지 않습니다. 명확하지 않으면 모델이 정확한 페이지/ref를 질문하도록 지시합니다.
- 자연어 즉시 승인은 `응`, `네`, `예`, `좋아`, `승인해`, `적용해`, `변경해` 등 제한된 명확한 표현만 받습니다. 현재 단일 제안과 표시 차수가 일치해야 합니다. “응, 하지만…” 같은 복합 문장은 승인하지 않고 모델과 논의합니다.
- 설명 요청 후의 “응”은 설명 확인인지 불명확하므로 **수정안을 다시 제시할 뿐 적용하지 않습니다**. 다시 보고 답해야 합니다. 복수 수정안은 하나를 명시적으로 선택해 다시 확인해야 합니다.
- 제시 ID, payload 버전, 표시 차수, 적용 대상, 실제 사용자 메시지 ID/본문을 문서 적용 이벤트에 함께 기록합니다. 문서 텍스트/모델 출력/도구 결과는 이 경로에 사용자 메시지로 들어오지 않습니다.
- 기존 항목 버전/스냅샷 검사로 오래된 제안을 막습니다. 같은 값으로 되돌아왔어도 중간 변경 이력이 있으면 충돌합니다. `검수 시작`으로 재진단하고 새 제안을 받으세요.
- 원본 이미지는 사용자 판단 근거입니다. 모델에는 이미지가 전달되지 않습니다. `original_text`는 최초 변환 결과이며 검증된 PDF 원문이 아닙니다. 불확실한 문자나 미지원 표 구조는 추측해 교정하지 않습니다.

## 중단·재개·실패

| 동작 | 의미 |
|---|---|
| 일시정지·중단 | 진행/추가 적용을 멈추고 실행 중 턴을 interrupt. 이미 확정한 트랜잭션은 결과로 남음 |
| 대화 재개 | 저장된 thread와 설정을 연결. 이전 메시지 재전송이나 대기 승인 자동 적용 없음 |
| 작업 다시 시도 | 실패한 진단 또는 모델 요청을 새 실행으로 명시 재시도. 승인 재시도가 아님 |
| 다음 항목 | 현재 문제의 판단을 만들지 않고 다음 대상 설명을 시작 |
| 전송 결과 확인·재시도 | 먼저 저장된 메시지/적용 이력을 조회. 접수된 ID는 절대 재실행하지 않음 |
| 변경 이력 → 마지막 적용 되돌리기 | 기존 undo 경로. 묶음은 한 번에 복구 |

새로고침은 진행 중인 서버 작업을 취소하지 않습니다. 서버 재시작은 대화를 **일시정지**하고 실행 중이던 턴을 중단 상태로 복구합니다. 내용·제안·판단·다음 위치·모델 설정은 서버 저장소에서 복원합니다. DB 반영 이후 대화 journal 저장에 실패한 경우에도 문서 적용 이벤트의 메시지 ID로 확정 사실을 확인합니다. 되돌림은 역사적 승인을 지우지 않고 현재 상태와 함께 표시합니다.

DB 확정 후 JSON 내보내기가 실패하면 일시정지하고 기존 `최신 확정 데이터 재내보내기`를 사용합니다. 재승인하지 않습니다. 미전송 입력과 응답 불확실 요청은 브라우저 저장소에도 남으며 브라우저 데이터를 지우면 없어질 수 있습니다.

## 구현 경계

`candoc/conversation.py`는 기존 `BatchReview`와 `Store`를 호출하는 진행/승인 연결부입니다. 별도 진단 엔진이나 교정 문서 모델을 만들지 않습니다. `conversation_offers`는 기존 proposal/batch ID와 표시 근거를 참조할 뿐입니다.

기존 `Chat`을 같은 권한 제한으로 재사용합니다. 검수 대화에는 읽기/제안 동적 도구 두 개를 추가하며, 기존 개별 채팅의 thread에 도구를 임의 추가하지 않습니다. 검수 대화는 설정 `state_dir/review-v1` 아래 독립 세션을 사용하고 이전 개별 대화는 보존합니다. 이후 재개는 같은 검수 thread를 사용합니다.

공식 [app-server 모델 목록](https://developers.openai.com/codex/app-server#list-models-modellist)의 `model/list`, `supportedReasoningEfforts`, `defaultReasoningEffort`를 사용합니다. 페이지를 모두 조회하며 실패/불완전 목록/미지원 조합은 오류입니다. 모델 이름과 effort를 하드코딩하지 않습니다. `turn/start.model`과 `turn/start.effort`에 선택값을 매번 보내고 턴의 고정 맥락에도 저장합니다. 연결만으로 특정 모델 접근이나 실행 성공을 보장하지 않으며 실제 실패는 그대로 표시합니다.

모든 턴의 `environments: []`, read-only/never, MCP·셸·파일 쓰기·사용자 승인 요청 거부는 기존 `codex_rpc.py` 정책을 유지합니다. 모델이 임의 HTTP/CLI/DB 접근이나 앱의 승인 경로를 호출할 수 없습니다. API 키 직접 호출·Paseo 의존성·인증 복사·새 로그인을 추가하지 않았습니다.

읽기 CLI:

```powershell
./.venv/Scripts/python -m candoc.cli conversation
./.venv/Scripts/python -m candoc.cli diagnostics
./.venv/Scripts/python -m candoc.cli history
```

대화 제어 API는 로컬 토큰·Host/Origin 검사를 거칩니다. `GET /api/conversation/state`, `POST .../models|settings|control|message`이며 범용 RPC 프록시가 아닙니다. CLI에는 승인 메시지 전송 명령을 추가하지 않았습니다.

## 검증

기존 실제 `data`와 ZIP, 52741 서버를 보존하고 임시 Asset 및 `verification/browser-data/conversation-20261006`/52742만 사용했습니다. 아래 기록은 구현 검증 시점의 결과입니다.

모의 실행기 시험은 실제 모델 대화 품질의 증거가 아닙니다. `tests/test_conversation.py`는 공식 RPC 형태의 별도 stdio 프로세스로 모델/effort 전달, 시작·진단·제안, 설명 후 재확인, 예외, 유지/보류, 복수 제안, 오래된 탭/제안, 다른 셀 선택, 동시 중복 승인, 중단/연결 끊김, 재시작, DB 실패, JSON 내보내기 실패, 적용 이후 journal 실패, 되돌리기를 검증합니다. 기존 workflow 테스트도 유지합니다.

**최종 전체 unittest 65개 통과(441.024초)**: 기존 53개 + 대화 검수 12개. [전체 실행 로그](../verification/conversation-20261006/all-tests-final.txt). 원본 ZIP과 기존 실제 `data` 파일 **343개 SHA-256 변경 없음**: [보존 검사](../verification/conversation-20261006/preservation.json).

브라우저:

- [대화 시작·설명·예외·자연어 승인·새로고침·undo](../verification/conversation-20261006/browser-flow.txt): 57개 중 137쪽 제외, 56개 한 번 적용, 한 번 undo로 원상복구.
- [재시작·응답 유실·선택 셀 고정·중단](../verification/conversation-20261006/browser-safety.txt): 승인 응답을 의도적으로 끊고 접수 이력으로 복구. 셀 1 제안 후 화면을 셀 2로 바꿔도 승인 대상은 셀 1.
- 화면: [첫 문제](../verification/conversation-20261006/browser-first.png), [예외 반영](../verification/conversation-20261006/browser-exception.png), [일시정지](../verification/conversation-20261006/browser-paused.png).
- 기존 보조 화면 회귀: [직접 교정/초안/승인](../verification/conversation-20261006/legacy-flow.txt), [선택·페이지 응답 경합](../verification/conversation-20261006/legacy-races.txt), [표 전체 유지·셀 보류·stale 재제안](../verification/conversation-20261006/legacy-decisions-final.txt), [기존 묶음 승인/예외/undo](../verification/conversation-20261006/legacy-batch.txt) 통과. 기존 스크립트는 보조 화면 진입과 증거 저장 경로만 조정했습니다. 숨겨진 묶음이 새로고침 시 문서 선택을 덮어쓰던 경합도 수정 후 재검증했습니다.
- [최종 설정·이동·레이아웃](../verification/conversation-20261006/browser-final.txt): 별도 설정 적용 클릭 없이 선택한 모델/effort로 시작, 자연어 다음/이전 이동, 1366×768 및 1920×1080에서 가로 넘침 없이 전송 버튼 접근 확인. [1366 화면](../verification/conversation-20261006/final-1366.png), [1920 화면](../verification/conversation-20261006/final-1920.png). 이 검사는 `tests/serve_conversation.py --case final`의 새 격리 사본에서 수행했고 revision 0을 유지했습니다.
- 모의 실행기의 복수 세션 저장을 수정한 뒤 [기존 Chat 20개](../verification/conversation-20261006/chat-fixture-final.txt)와 [대화 검수 12개](../verification/conversation-20261006/conversation-fixture-final.txt)를 다시 통과했습니다. 단일 셀 후속 대화에 다른 셀이나 원시 표 전체가 전달되지 않도록 최소화한 뒤 [대상 고정·충돌 시험](../verification/conversation-20261006/cell-context-final.txt)도 통과했습니다. 초기 세션 토큰을 읽기 전에는 모델 조회 버튼이 잠깁니다.

사용자 승인 아래 **실제 설치·로그인된 Codex 0.160.0 / gpt-6.1-sol / low, 최대 3턴**을 실행했습니다. 공식 목록의 기본 모델/지원 effort를 선택했습니다. 첫 57개 묶음 설명, 추가 근거·원문 불확실성 설명, 137쪽 `#/texts/2882` 제외 후 56개 pending 제안 생성까지 완료했습니다. **실제 모델 시험에서는 승인 0회, 문서 revision 0**, 새 인증/추가 권한도 없었습니다. [실제 응답·목록·설정 기록](../verification/conversation-20261006/actual-model.json)은 모의 시험과 별도입니다. 기록의 `probe_reporting_note`는 원본 검사 반환형을 boolean으로 잘못 표시했던 시험 보고 코드의 정정을 설명하며, 추가 모델 호출은 수행하지 않았습니다.

한계: 다른 PC·모든 모델/effort·대규모 문서/장기 대화의 품질은 미검증입니다. 이미지 판독이나 문서 전체 정확성·누락 탐지 능력을 검증한 것이 아닙니다. 구조 변경 지원 범위는 기존과 같습니다. 모델의 자유로운 표현이 항상 기대한 제안을 생성한다는 보장도 없으며, 앱의 적용 권한 검사는 모델 응답과 독립적입니다.

재현:

```powershell
./.venv/Scripts/python -m unittest discover -s tests -v
./.venv/Scripts/python tests/serve_conversation.py
playwright-cli -s=candoc-conversation open http://127.0.0.1:52742
playwright-cli -s=candoc-conversation run-code --filename=tests/browser-conversation.js
# 시험 서버 재시작 후, 같은 시험 Asset으로:
playwright-cli -s=candoc-conversation run-code --filename=tests/browser-conversation-safety.js
```

실제 모델 probe는 unittest에 포함되지 않습니다. 다시 실행하려면 새 사용자 승인이 필요합니다. `tests/probe_conversation_live.py --authorized-three-turns --output <path>`는 과금 가능한 실제 최대 3턴을 실행하므로 자동 회귀로 호출하지 마세요.

## 주요 변경 파일

| 파일 | 변경 |
|---|---|
| `candoc/conversation.py` | 진행 상태, 읽기/제안 broker, 표시한 제안과 자연어 승인 연결, 복구 |
| `candoc/chat.py` | 공식 모델/effort 조회·검증과 턴 요청 반영, 기존 Chat 재사용 |
| `candoc/core.py`, `candoc/batch.py` | 기존 승인 트랜잭션에 대화 승인 근거 추가 |
| `candoc/server.py`, `candoc/cli.py` | 로컬 대화 API와 읽기 CLI |
| `web/conversation.js`, `web/index.html`, `web/style.css`, `web/batch.js` | 대화 기본 화면, 원본/수정안 연결, 보조 화면 유지 |
| `tests/test_conversation.py`, `tests/fake_codex.py`, `tests/browser-conversation*.js` | 모의 실행기 및 격리 브라우저 회귀 |
| `tests/serve_conversation.py`, `tests/probe_conversation_live.py` | 격리 서버, 명시 승인 전용 실제 모델 시험 |
| `README.md`, `docs/AGENT.md`, `docs/SCHEMA.md`, `docs/CODEX-CHAT.md` | 사용자 흐름·외부 에이전트 경계·승인 기록 계약 갱신 |
