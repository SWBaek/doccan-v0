# Asset과 DoclingDocument 조사

## 확인한 입력

`document.json`은 `schema_name=DoclingDocument`, `version=1.10.0`입니다. 138페이지, 텍스트 2,937개, 표 71개, 그림 29개, 그룹 73개입니다. ZIP은 JSON 1개와 PNG 167개를 포함하며 PDF는 없습니다. 페이지 이미지 138개와 그림 이미지 29개의 파일·크기를 실제 검사했습니다.

변환 환경은 `config/conversion-environments.json`에서 정의하고 각 Asset은 `environment_id`와 `schema_version`으로 식별합니다. Docling 2.124.0 / Serve 1.32.0 / core 2.93.0 / CUDA128 Docker 이미지와 REST 사용은 **사용자 제공 프로젝트 설정**입니다. 실행 서버, 변환 옵션, 실제 변환 실행 정보는 확인하지 않았으며 null로 남겼습니다. 이 앱에 설치한 core 버전은 2.93.0으로 별도 검증합니다.

## 고정 버전의 공식 구현

조사는 설치한 `docling-core==2.93.0` 소스와 다음 공식 tag를 기준으로 했습니다. 최신 문서를 고정 버전의 계약으로 간주하지 않았습니다.

- [document.py, v2.93.0](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/types/doc/document.py): DoclingDocument, 배열·트리 참조, validation, HTML export.
- [text.py, v2.93.0](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/types/doc/items/text.py): TextItem 및 제목·목록·수식 하위 타입.
- [reference.py, v2.93.0](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/types/doc/common/reference.py): RefItem, ProvenanceItem, PageItem.
- [table_data.py, v2.93.0](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/types/doc/items/table/table_data.py): TableData, TableCell 및 grid.
- [base.py, v2.93.0](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/types/doc/base.py): BoundingBox와 원점 변환.
- [html.py, v2.93.0](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/transforms/serializer/html.py), [common.py](https://github.com/docling-project/docling-core/blob/v2.93.0/docling_core/transforms/serializer/common.py): 공식 serializer와 labels/layers/pages 필터.

## 유지해야 할 계약

| 필드 | 의미와 수정 조건 |
|---|---|
| `body`, `furniture`, `groups`, `texts`, `tables`, `pictures` | 공식 타입과 배열을 그대로 사용. 별도 문서 스키마로 바꾸지 않음 |
| `self_ref`, `parent.$ref`, `children[].$ref` | JSON Pointer와 트리 연결. 실제 배열 위치, 부모/자식 일관성, 중복·순환·참조 대상을 검사 |
| `captions`, `footnotes`, `references` | 그림·표의 연관 항목 참조. 화면 캡션은 독립 선택 가능하며 JSON 관계 보존 |
| `label`, `content_layer` | 항목의 타입과 문서의 내용 계층은 별개. 타입 변경은 지원 목록에 제한 |
| `text`, `orig` | 교정된 표시 내용과 최초 미처리 표현. `text`만 승인 변경하고 `orig` 보존 |
| `prov[]` | `page_no`, `bbox`, `charspan`. 원본 위치 정보. 최초 값을 source-links와 원본 JSON에 보존 |
| `pages` | 페이지 번호 키, size, page_no, image. 이미지 실제 픽셀 크기는 페이지 단위 좌표와 다를 수 있음 |
| `data.table_cells` | 셀 배열. start/end 행열 offset, row_span/col_span, header 플래그, text, bbox를 보존 |
| `image.uri` | 기존 상대 PNG 참조. 작업 사본의 artifacts에도 동일 파일을 복사해 연결 유지 |

`DoclingDocument.model_validate()`에는 트리 검증 외에 bbox clamp와 misplaced list 정규화가 있습니다. 따라서 저장 대상으로 `model_dump()`를 쓰지 않습니다. 원시 JSON을 깊은 복사한 뒤 허용된 필드만 바꾸고, 별도 복사본을 공식 모델로 검증합니다. 정규화가 배열 길이·self_ref·parent를 바꾸면 거부합니다. 원시 JSON의 미지정 필드를 손실 없이 보존합니다.

텍스트의 단일 prov는 새 text 전체로 charspan을 갱신합니다. 최초 charspan은 원본/연결 파일/변경 전 이력에 남습니다. 여러 prov의 span을 추정 재배분하지 않습니다. 구조 수정은 모두 거부하므로 참조 재매핑은 발생하지 않습니다. 향후 구조 지원 시 최초 ref·prov와 새 ref의 명시적인 다대다 대응이 필요합니다.

## 표시와 좌표

문서 전체 export와 split-page 기능을 검토했습니다. 항목 클릭·셀 index 연결과 furniture/캡션 접근을 위해 공식 `HTMLTextSerializer`, `HTMLTableSerializer`, `HTMLPictureSerializer`를 그대로 사용하고 항목 카드와 선택 속성만 추가했습니다. 본문 순서는 공식 iterate_items를 사용하고, 누락 항목은 원본 배열로 보완합니다. 캡션을 중복 출력하지 않도록 카드별 serializer의 캡션 출력을 생략하고 각 캡션 항목을 따로 표시합니다. HTML에서 실행 코드·외부 링크/이미지를 제거하며 JSON에는 영향을 주지 않습니다.

원본 요소 bbox 3,055건은 BOTTOMLEFT, 셀 bbox 2,991건은 TOPLEFT입니다. 각각 선언된 원점을 읽습니다. BOTTOMLEFT에서는 `top = page_height - t`, `bottom = page_height - b`; TOPLEFT는 그대로 씁니다. 페이지 표시 비율은 page.size 기준이고, 캡처 픽셀은 실제 이미지 width/height와 각각 비례시킵니다. 원점을 모르면 거부합니다. 셀 bbox는 표 상대 좌표로 임의 해석하지 않습니다.

전체 범위 검사에서 표 `#/tables/56`의 셀 범위 겹침 1건이 확인됐습니다. 공식 모델이 받아들이는 최초 구조를 보존하고 별도 경고·의심 후보로 관리합니다. 구조 오류를 자동 복구하지 않습니다.

## 반복 헤더·푸터 묶음 재분류

고정 core 2.93.0의 `items/text.py`에서 page_header/page_footer는 TextItem이며 section_header의 level은 SectionHeaderItem 전용 필드입니다. `items/node.py`의 content_layer는 parent/children과 독립된 필드입니다. 따라서 승인된 leaf 항목의 label, content_layer=furniture, level 제거만 허용하고 트리를 옮기지 않습니다. text/orig/prov/charspan/self_ref/parent/children 및 모든 연결은 그대로 둡니다. 후보 전체를 원시 JSON 사본에 반영해 공식 모델과 추가 참조 검사로 검증하며 model_dump 결과를 저장하지 않습니다.

묶음 제안·진단·판단은 별도 SQLite 테이블에 둡니다. 변경 이력은 기존 apply/undo에 refs와 대상별 before/after를 추가해 한 revision으로 기록합니다. 기존 단일 항목 이력은 변경하지 않습니다. 모든 대상의 스냅샷·변경 이력을 다시 검사한 뒤 하나의 DB 트랜잭션으로 확정합니다. 묶음 판단의 individually_reviewed=false는 DoclingDocument 밖 검수 기록에만 저장합니다.

## 대화 승인 근거

`conversation_state/messages/offers/tool_calls`는 작업 검수 DB의 별도 테이블이며 DoclingDocument 필드를 추가하지 않습니다. offer는 기존 proposal/batch ID를 참조하는 표시 기록입니다. 내용·대상은 기존 불변 제안에 있고, offer 버전은 해당 payload의 SHA-256입니다.

대화 승인은 기존 적용 이력에 `conversation_approval`을 추가합니다. 실제 사용자 메시지 ID/본문, 제시 ID/버전/표시 차수, 적용 proposal ID와 대상·셀·revision을 문서 변경과 같은 트랜잭션으로 기록합니다. 승인 후 대화 상태 저장이 실패해도 이 기록으로 적용 사실을 복구하며 재적용하지 않습니다. undo는 기존 문서/검수 복구 경로를 사용하고 역사적 승인 근거를 삭제하지 않습니다.
