"""Official HTML item serializers plus selection attributes; display only."""
import copy
from urllib.parse import unquote

from docling_core.types.doc import ContentLayer, DocItemLabel, DoclingDocument, ImageRefMode
from docling_core.transforms.serializer.html import HTMLDocSerializer, HTMLParams
from docling_core.transforms.serializer.common import create_ser_result
from lxml import html

from .core import items, resolve


class ReviewSerializer(HTMLDocSerializer):
    def serialize_captions(self, **kwargs):
        # Captions have their own independently selectable item cards.
        return create_ser_result(text='')


def sanitize(fragment):
    root = html.fragment_fromstring(fragment or '<p>(표시 내용 없음)</p>', create_parent='div')
    for el in list(root.iterdescendants()):
        if not isinstance(el.tag, str):
            el.getparent().remove(el)
            continue
        if el.tag.lower() in {'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button'}:
            el.drop_tree()
            continue
        for key in list(el.attrib):
            if key not in {'rowspan', 'colspan', 'src', 'alt', 'dir', 'class', 'display', 'mathvariant', 'xmlns'}:
                del el.attrib[key]
        if 'src' in el.attrib:
            uri = unquote(el.attrib['src']).replace('\\', '/')
            if uri.startswith('artifacts/') and '..' not in uri:
                el.attrib['src'] = '/asset/' + uri
                el.attrib['loading'] = 'lazy'
            else:
                del el.attrib['src']
    return root


def render_page(doc, page_no):
    model = DoclingDocument.model_validate(copy.deepcopy(doc))
    params = HTMLParams(layers=set(ContentLayer), labels=set(DocItemLabel), image_mode=ImageRefMode.REFERENCED, include_hyperlinks=False, allowed_meta_names=set(), formula_to_mathml=True)
    serializer = ReviewSerializer(doc=model, params=params)
    ordered = []
    seen = set()
    for v, _ in model.iterate_items(traverse_pictures=True, included_content_layers=set(ContentLayer)):
        if hasattr(v, 'prov') and v.self_ref not in seen:
            ordered.append(v.self_ref)
            seen.add(v.self_ref)
    ordered += [v['self_ref'] for v in items(doc) if v['self_ref'] not in seen]
    all_refs = {v['self_ref'] for v in items(doc)}
    result = []
    for ref in ordered:
        raw = resolve(doc, ref)
        if not any(p['page_no'] == page_no for p in raw.get('prov', [])):
            continue
        item = model
        for key in ref[2:].split('/'):
            item = item[int(key)] if isinstance(item, list) else getattr(item, key)
        part_serializer = serializer.text_serializer if ref.startswith('#/texts/') else serializer.table_serializer if ref.startswith('#/tables/') else serializer.picture_serializer
        fragment = part_serializer.serialize(item=item, doc_serializer=serializer, doc=model, visited=all_refs-{ref}, **params.model_dump()).text
        root = sanitize(fragment)
        if ref.startswith('#/tables/'):
            positions = {}
            for i,c in enumerate(raw['data']['table_cells']):
                pos = (c['start_row_offset_idx'], c['start_col_offset_idx'])
                positions[pos] = i if pos not in positions else None
            covered = set()
            for row_no, row in enumerate(root.xpath('.//table/tr | .//table/tbody/tr')):
                col = 0
                for cell in row:
                    while (row_no, col) in covered:
                        col += 1
                    idx = positions.get((row_no, col))
                    if idx is not None:
                        cell.set('data-cell', str(idx))
                        cell.set('tabindex', '0')
                    rs, cs = int(cell.get('rowspan', '1')), int(cell.get('colspan', '1'))
                    covered.update((r,c) for r in range(row_no,row_no+rs) for c in range(col,col+cs))
                    col += cs
        result.append({'ref': ref, 'label': raw['label'], 'html': html.tostring(root, encoding='unicode'), 'text': raw.get('text', ''), 'locations': raw.get('prov', [])})
    return result
