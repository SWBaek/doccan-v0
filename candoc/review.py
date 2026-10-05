"""Read-only review projections. Never rewrite the document or decision history."""


def review_state(reviews, ref, cell=None):
    scope = ref if cell is None else f'{ref}/cells/{cell}'
    own = reviews.get(scope, {'state': 'unreviewed', 'revision': -1})
    if cell is not None:
        return own['state']
    children = [v for k, v in reviews.items() if k.startswith(ref+'/cells/')]
    # A later whole-table judgment covers earlier cell judgments. Later exceptions
    # remain visible; they do not erase the historical whole-table decision.
    later = [v for v in children if v.get('revision', 0) > own.get('revision', -1)]
    if any(v['state'] == 'deferred' for v in later):
        return 'deferred'
    if any(v['state'] == 'corrected_partial' for v in later):
        return 'corrected_partial'
    return own['state']


def edit_capability(item, cell=None):
    if cell is not None:
        if 'ref' not in item['data']['table_cells'][cell]:
            return {'op': 'cell', 'reason': ''}
        return {'op': None, 'reason': '참조를 포함한 rich cell은 수정할 수 없습니다. 원본 확인 후 보류하세요.'}
    if item['self_ref'].startswith('#/texts/'):
        if item.get('children'):
            reason = '자식 항목이 있는 텍스트는 수정할 수 없습니다. 하위 항목을 선택하거나 보류하세요.'
        elif len(item.get('prov', [])) != 1:
            reason = '원본 위치가 없거나 여러 개인 텍스트는 범위 매핑 없이 수정할 수 없습니다. 위치별로 확인 후 보류하세요.'
        else:
            return {'op': 'text', 'reason': ''}
    elif item['self_ref'].startswith('#/tables/'):
        reason = '표 구조 편집은 지원하지 않습니다. 일반 셀을 선택해 내용만 수정하거나 표를 보류하세요.'
    else:
        reason = '이 대상의 내용 수정은 지원하지 않습니다. 원본 확인 후 유지 또는 보류하세요.'
    return {'op': None, 'reason': reason}


def search_items(document_items, query):
    query = query.strip().lower()
    if not query:
        return []
    found = []
    for item in document_items:
        ref = item['self_ref']
        prov = item.get('prov', [])
        page = prov[0]['page_no'] if prov else None
        targets = [(None, item.get('text', item['label']))]
        targets += [(i, c['text']) for i, c in enumerate(item.get('data', {}).get('table_cells', []))]
        for cell, text in targets:
            pos = text.lower().find(query)
            if pos < 0 and not (cell is None and query in ref.lower()):
                continue
            start = max(0, pos-75)
            end = min(len(text), max(pos, 0)+len(query)+140)
            result = {'ref': ref, 'cell': cell, 'page': page if cell is None or len(prov) == 1 else None,
                      'table_page': page if cell is not None else None,
                      'text': ('…' if start else '')+text[start:end]+('…' if end < len(text) else ''),
                      'location_note': ''}
            if cell is not None:
                c = item['data']['table_cells'][cell]
                result.update(row=c['start_row_offset_idx']+1, column=c['start_col_offset_idx']+1)
                if len(prov) != 1 or not c.get('bbox'):
                    result['location_note'] = '셀 원본 위치 확인 불가 · 표 전체 위치로 확인'
            found.append(result)
    return found
