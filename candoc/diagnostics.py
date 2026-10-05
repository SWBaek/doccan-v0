"""Deterministic, evidence-bearing candidates. No OCR, source text inference or edits."""
import hashlib
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher

from .core import rect, resolve

VERSION = 'margin-v1'

def key(text):
    text = re.sub(r'\s+', ' ', text.casefold()).strip()
    if re.fullmatch(r'[ivxlcdm]+', text):
        return '<page>'
    return re.sub(r'\d+', '#', text)


def detect(doc, progress=lambda n, total: None, cancelled=lambda: False):
    """Conservative rules; thresholds are heuristics, never calibrated accuracy."""
    associated = {v['$ref'] for coll in ('tables', 'pictures') for item in doc[coll]
                  for field in ('captions', 'footnotes', 'references') for v in item.get(field, [])}
    tables = defaultdict(list)
    bypage = defaultdict(list)
    for table in doc['tables']:
        for prov in table.get('prov', []):
            tables[prov['page_no']].append(rect(prov['bbox'], doc['pages'][str(prov['page_no'])]['size']))
    for item in doc['texts']:
        if len(item.get('prov', [])) == 1:
            bypage[item['prov'][0]['page_no']].append(item)
    candidates = []
    pages = sorted(map(int, doc['pages']))
    for n, page in enumerate(pages, 1):
        if cancelled():
            raise InterruptedError('진단 취소됨. 이전 완료 결과를 유지합니다.')
        size = doc['pages'][str(page)]['size']
        for item in bypage[page]:
            if item['self_ref'] in associated or item.get('children') or item['label'] not in {'text','paragraph','section_header','page_header','page_footer'}:
                continue
            text = item.get('text', '').strip()
            if not text or len(text) > 220 or re.match(r'^(note\b|warning\b|caution\b|주의|비고|\d+[).]\s)', text, re.I):
                continue
            box = rect(item['prov'][0]['bbox'], size)
            y, bottom = box['y']/size['height'], (box['y']+box['height'])/size['height']
            side = 'page_header' if bottom <= .105 else 'page_footer' if y >= .90 else None
            if side == 'page_footer' and re.match(r'^\d+\s+[^\d\s]', text):
                continue  # Unlabelled numbered footnote, not a bare page number.
            if not side or box['height']/size['height'] > .065:
                continue
            # Table column headings and captions must not become furniture.
            def overlap(b):
                return min(box['x']+box['width'], b['x']+b['width']) > max(box['x'],b['x']) and min(box['y']+box['height'],b['y']+b['height']) > max(box['y'],b['y'])
            if any(overlap(b) for b in tables[page]):
                continue
            # Require interior text separated from this marginal item.
            separated = any(other['self_ref'] != item['self_ref'] and .12 < rect(other['prov'][0]['bbox'],size)['y']/size['height'] < .88 for other in bypage[page])
            separated = separated or any(.12 < (b['y']+b['height']/2)/size['height'] < .88 for b in tables[page])
            if not separated:
                continue
            candidates.append(dict(item=item,page=page,y=y,key=key(text),side=side))
        progress(n, len(pages))
    clusters = []
    for c in sorted(candidates, key=lambda c:(c['side'],c['key'],c['page'])):
        group = next((g for g in clusters if g[0]['side']==c['side'] and abs(g[0]['y']-c['y'])<=.014
                      and (g[0]['key']==c['key'] or min(len(g[0]['key']),len(c['key']))>=25 and SequenceMatcher(None,g[0]['key'],c['key'],autojunk=False).ratio()>=.90)), None)
        if group is None:clusters.append([c])
        else:group.append(c)
    groups = []
    def add(kind, identity, title, reason, targets, evidence, priority):
        if targets:
            groups.append(dict(id=hashlib.sha256((VERSION+kind+identity).encode()).hexdigest()[:20],kind=kind,title=title,
                               reason=reason,targets=targets,evidence=evidence,priority=priority,rule_version=VERSION))
    for cluster in clusters:
        unique = sorted({c['page'] for c in cluster})
        if len(unique)<3:continue
        side=cluster[0]['side']; anchors=sum(c['item']['label']==side for c in cluster)
        density=len(unique)/(unique[-1]-unique[0]+1)
        parity=max(sum(p%2==v for p in unique)/max(1,sum(p%2==v for p in range(unique[0],unique[-1]+1))) for v in (0,1))
        if anchors<2 and (len(unique)<4 or max(density,parity)<.6):continue
        targets=[]
        for c in cluster:
            v=c['item']
            if v['label']==side and v.get('content_layer')=='furniture':continue
            # A repeated heading alone is insufficient. Existing header anchors
            # plus the geometric/table/leaf tests are required for heading changes.
            if v['label']=='section_header' and anchors<2:continue
            targets.append(dict(ref=v['self_ref'],page=c['page'],suggested=side,
                                evidence=dict(top_ratio=round(c['y'],4),parent=v.get('parent'),current_label=v['label'],current_layer=v.get('content_layer'))))
        name='헤더' if side=='page_header' else '푸터'
        exemplar=Counter(c['item']['text'] for c in cluster).most_common(1)[0][0]
        add('margin', side+min(c['key'] for c in cluster), f'반복 {name} 재분류 · {exemplar[:90]}',
            f'{len(unique)}개 페이지의 같은 가장자리에서 유사 문구 반복. 기존 {name} 분류 {anchors}건과 비교하여 본문/제목 분류를 재검토합니다.',targets,
            dict(pattern=exemplar,pages=unique,occurrences=len(cluster),anchors=anchors,top_ratio_range=[round(min(c['y'] for c in cluster),4),round(max(c['y'] for c in cluster),4)],odd=sum(p%2==1 for p in unique),even=sum(p%2==0 for p in unique),variants=sorted({c['item']['text'] for c in cluster}),variant_pages={text:sorted({c['page'] for c in cluster if c['item']['text']==text}) for text in sorted({c['item']['text'] for c in cluster})},checks='leaf · 단일 원본 위치 · 내부 본문/표 존재 · 표/캡션/각주 참조 제외',thresholds='가장자리 10.5%/10%, 위치 차 1.4%, 문구 유사도 0.90; 경험 규칙이며 정확도 아님'),1)
    overlaps=[]
    for table in doc['tables']:
        occupied={};pairs=[]
        for i,c in enumerate(table['data']['table_cells']):
            for row in range(c['start_row_offset_idx'],c['end_row_offset_idx']):
                for col in range(c['start_col_offset_idx'],c['end_col_offset_idx']):
                    if (row,col) in occupied:pairs.append([occupied[row,col],i,row,col])
                    occupied[row,col]=i
        if pairs:overlaps.append(dict(ref=table['self_ref'],page=table['prov'][0]['page_no'] if table.get('prov') else None,suggested=None,evidence=dict(overlapping_cells=pairs)))
    add('table_overlap','all','표 셀의 행·열 범위가 겹침','동일 격자 위치를 여러 셀이 차지합니다. 원본과 셀 목록을 확인하세요. 구조 변경은 지원하지 않아 수정안을 만들지 않습니다.',overlaps,{},2)
    heading=[]
    margin_refs={t['ref'] for g in groups for t in g['targets']}
    for t in doc['texts']:
        m=re.match(r'^(\d+(?:\.\d+)+)\.?\s+\S',t.get('text',''))
        if t['label']=='section_header' and t['self_ref'] not in margin_refs and m and len(m[1].split('.'))!=t.get('level',1):
            heading.append(dict(ref=t['self_ref'],page=t['prov'][0]['page_no'] if t.get('prov') else None,suggested=None,evidence=dict(number=m[1],number_depth=len(m[1].split('.')),stored_level=t.get('level',1))))
    add('heading_level','numbered','번호 깊이와 제목 단계가 다름','번호의 점 개수와 저장된 level이 다릅니다. 번호 체계가 실제 계층인지 원본·주변 제목으로 확인하세요. 번호만으로 level을 자동 수정하지 않습니다.',heading,{},3)
    return sorted(groups,key=lambda g:(g['priority'],-len(g['targets']),g['id']))
