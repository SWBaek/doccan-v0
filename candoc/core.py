from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import uuid
import zipfile
from importlib.metadata import version
from collections import Counter
from datetime import datetime, timezone

from docling_core.types.doc import DoclingDocument
from PIL import Image

from .review import review_state

ROOT = Path(__file__).resolve().parent.parent
COLLECTIONS = ('texts', 'tables', 'pictures', 'groups', 'key_value_items', 'form_items')
TYPE_LABELS = {'text', 'paragraph', 'section_header', 'title', 'page_header', 'page_footer'}


class ProposalConflict(ValueError):
    """A rejected decision with enough state for clients to reconcile safely."""
    def __init__(self, message, proposal):
        super().__init__(message)
        self.proposal = proposal


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)


def atomic(path, content):
    path = Path(path)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with tmp.open('w', encoding='utf-8', newline='\n') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        # Only this call's temporary file; never remove the previous export.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def resolve(doc, ref):
    if not isinstance(ref, str) or not ref.startswith('#/'):
        raise ValueError('Invalid local JSON reference')
    value = doc
    for key in ref[2:].split('/'):
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def nodes(doc):
    return [doc['body'], doc['furniture']] + [v for k in COLLECTIONS for v in doc.get(k, [])]


def items(doc):
    return [v for k in ('texts', 'tables', 'pictures', 'key_value_items', 'form_items') for v in doc.get(k, [])]


def walk(value):
    if isinstance(value, dict):
        yield value
        for v in value.values():
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)


def local_path(root, uri):
    if not isinstance(uri, str) or ':' in uri or '\\' in uri:
        raise ValueError(f'Only relative asset paths are supported: {uri}')
    path = (root / uri).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'Missing or unsafe asset: {uri}')
    return path


def rect(bbox, size):
    """Normalize one declared bbox origin to top-left page units; never guess."""
    l, r, t, b = (bbox[k] for k in ('l', 'r', 't', 'b'))
    if bbox['coord_origin'] == 'BOTTOMLEFT':
        t, b = size['height'] - t, size['height'] - b
    elif bbox['coord_origin'] != 'TOPLEFT':
        raise ValueError('Unknown coordinate origin')
    if r < l or b < t:
        raise ValueError('Inverted bbox')
    return {'x': l, 'y': t, 'width': r-l, 'height': b-t}


def validate(doc, source=None, images=False):
    if doc.get('schema_name') != 'DoclingDocument' or doc.get('version') != '1.10.0':
        raise ValueError('This MVP requires DoclingDocument schema 1.10.0')
    model = DoclingDocument.model_validate(copy.deepcopy(doc))
    # Some upstream validators normalize references. Never permit invisible remapping.
    for k in COLLECTIONS:
        parsed = getattr(model, k)
        if len(parsed) != len(doc.get(k, [])):
            raise ValueError('Upstream structural normalization would change item identities')
        for a, b in zip(doc.get(k, []), parsed):
            if a['self_ref'] != b.self_ref or a.get('parent') != (b.parent.model_dump(by_alias=True) if b.parent else None):
                raise ValueError('Upstream structural normalization would change references')
    all_nodes = nodes(doc)
    refs = [v['self_ref'] for v in all_nodes]
    if len(refs) != len(set(refs)):
        raise ValueError('Duplicate self_ref')
    for v in all_nodes:
        if resolve(doc, v['self_ref']) is not v:
            raise ValueError('self_ref does not match array position')
        for child in v.get('children', []):
            if resolve(doc, child['$ref']).get('parent', {}).get('$ref') != v['self_ref']:
                raise ValueError('Child/parent mismatch')
    ref_count = 0
    for v in walk(doc):
        if '$ref' in v:
            resolve(doc, v['$ref'])
            ref_count += 1
    # Explicit child graph cycle detection, even for disconnected nodes.
    visiting, done = set(), set()
    def visit(ref):
        if ref in visiting:
            raise ValueError('Child cycle')
        if ref in done:
            return
        visiting.add(ref)
        for c in resolve(doc, ref).get('children', []):
            visit(c['$ref'])
        visiting.remove(ref)
        done.add(ref)
    for ref in refs:
        visit(ref)
    bbox_origins, cell_origins, warnings = Counter(), Counter(), []
    for item in items(doc):
        for prov in item.get('prov', []):
            page = doc['pages'][str(prov['page_no'])]
            box = rect(prov['bbox'], page['size'])
            bbox_origins[prov['bbox']['coord_origin']] += 1
            if box['x'] < -1 or box['y'] < -1 or box['x']+box['width'] > page['size']['width']+1 or box['y']+box['height'] > page['size']['height']+1:
                warnings.append(f"Out of page bbox: {item['self_ref']}")
    for table in doc['tables']:
        data = table['data']
        occupied = set()
        for cell in data['table_cells']:
            rs, re, cs, ce = (cell[k] for k in ('start_row_offset_idx', 'end_row_offset_idx', 'start_col_offset_idx', 'end_col_offset_idx'))
            if not (0 <= rs < re <= data['num_rows'] and 0 <= cs < ce <= data['num_cols'] and re-rs == cell['row_span'] and ce-cs == cell['col_span']):
                raise ValueError(f"Invalid table span: {table['self_ref']}")
            positions = {(r,c) for r in range(rs,re) for c in range(cs,ce)}
            if positions & occupied:
                warnings.append(f"Overlapping table cells (preserved): {table['self_ref']}")
            occupied |= positions
            if cell.get('bbox'):
                cell_origins[cell['bbox']['coord_origin']] += 1
                if len(table['prov']) == 1:
                    rect(cell['bbox'], doc['pages'][str(table['prov'][0]['page_no'])]['size'])
    image_count = 0
    if images:
        for v in walk(doc):
            if 'uri' in v and 'mimetype' in v and 'dpi' in v:
                path = local_path(source, v['uri'])
                with Image.open(path) as im:
                    if list(im.size) != [v['size']['width'], v['size']['height']]:
                        raise ValueError(f'Image dimensions mismatch: {path.name}')
                    im.verify()
                image_count += 1
        for key, page in doc['pages'].items():
            if int(key) != page['page_no'] or not page.get('image'):
                raise ValueError('Missing page image or mismatched page number')
    return {'schema': doc['version'], 'pages': len(doc['pages']), 'texts': len(doc['texts']), 'tables': len(doc['tables']), 'pictures': len(doc['pictures']), 'references_checked': ref_count, 'images_checked': image_count, 'element_bbox_origins': dict(bbox_origins), 'cell_bbox_origins': dict(cell_origins), 'warnings': warnings}


def initialize(archive, data):
    data = Path(data).resolve()
    if (data / 'manifest.json').exists():
        raise ValueError('Asset already initialized; refusing to replace it')
    if data.exists() and any(p.name != 'source' for p in data.iterdir()):
        raise ValueError('Initialization destination must be empty (or an exact interrupted extraction)')
    data.mkdir(parents=True, exist_ok=True)
    source = data / 'source'
    source.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            dest = (source / member.filename).resolve()
            if not dest.is_relative_to(source) or ':' in member.filename or '\\' in member.filename:
                raise ValueError('Unsafe archive path')
        for member in z.infolist():
            dest = source / member.filename
            if member.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                content = z.read(member)
                if dest.exists() and dest.read_bytes() != content:
                    raise ValueError('Interrupted extraction differs from archive; refusing overwrite')
                if not dest.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(content)
    doc = json.loads((source/'document.json').read_text('utf-8'))
    report = validate(doc, source, images=True)
    fingerprints = {p.relative_to(source).as_posix(): sha(p) for p in source.rglob('*') if p.is_file()}
    manifest = {'asset_id': 'ieee1547-' + fingerprints['document.json'][:12], 'environment_id': 'docling-user-provided-v1', 'environment_registry': 'config/conversion-environments.json', 'schema_name': doc['schema_name'], 'schema_version': doc['version'], 'archive_name': Path(archive).name, 'archive_sha256': sha(archive), 'source_files': fingerprints, 'original_pdf_present': any(p.suffix.lower()=='.pdf' for p in source.rglob('*')), 'initial_validation': report}
    atomic(data/'manifest.json', dump(manifest))
    atomic(data/'source-links.json', dump({v['self_ref']: {'original_ref': v['self_ref'], 'prov': v.get('prov', [])} for v in nodes(doc)}))
    work = data/'work'
    work.mkdir()
    shutil.copytree(source/'artifacts', work/'artifacts')
    shutil.copyfile(source/'document.json', work/'document.json')
    store = Store(data)
    store.close()
    return manifest


class Store:
    def __init__(self, data):
        if version('docling-core') != '2.93.0':
            raise ValueError('Install the pinned docling-core==2.93.0 before opening this workspace')
        self.data = Path(data).resolve()
        self.source = self.data/'source'
        # Keep one writer process per workspace, including the JSON export.
        self.lockfile = (self.data/'work/server.lock').open('a+b')
        self.lockfile.seek(0)
        if os.name == 'nt':
            import msvcrt
            try:
                msvcrt.locking(self.lockfile.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                self.lockfile.close()
                raise ValueError('This workspace is already open in another server') from None
        else:
            import fcntl
            fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.manifest = json.loads((self.data/'manifest.json').read_text('utf-8'))
        self.original = json.loads((self.source/'document.json').read_text('utf-8'))
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.data/'work/review.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''CREATE TABLE IF NOT EXISTS current (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL, reviews TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS exports (name TEXT PRIMARY KEY, revision INTEGER, error TEXT);
        CREATE TABLE IF NOT EXISTS proposal_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, proposal TEXT NOT NULL);''')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO current VALUES (1,0,?,?)', (dump(self.original), '{}'))
            self.db.executemany('INSERT OR IGNORE INTO exports VALUES (?,NULL,NULL)',
                                [('document.json',), ('review.json',)])
        self._export_metadata_error = None
        self.export()

    def close(self):
        self.db.close()
        self.lockfile.close()

    def current(self):
        revision, document, reviews = self.db.execute('SELECT revision,document,reviews FROM current').fetchone()
        return revision, json.loads(document), json.loads(reviews)

    def export_status(self):
        with self.lock:
            revision = self.db.execute('SELECT revision FROM current WHERE id=1').fetchone()[0]
            rows = self.db.execute('SELECT name,revision,error FROM exports').fetchall()
            files = {name: exported for name, exported, _ in rows}
            errors = {name: error for name, _, error in rows if error}
            if self._export_metadata_error:
                errors['status'] = self._export_metadata_error
            return {'state': 'synced' if not errors and all(v == revision for v in files.values()) else 'pending',
                    'db_revision': revision, 'files': files, 'errors': errors}

    def export(self):
        """Retry the latest committed snapshot; never approve or replay a change."""
        with self.lock:
            revision, doc, reviews = self.current()
            updates = []
            for name, value in [('document.json', doc), ('review.json', reviews)]:
                try:
                    atomic(self.data/'work'/name, dump(value))
                    updates.append((name, revision, None))
                except OSError as exc:
                    previous = self.db.execute('SELECT revision FROM exports WHERE name=?', (name,)).fetchone()[0]
                    updates.append((name, previous, str(exc)))
            try:
                with self.db:
                    self.db.executemany('INSERT OR REPLACE INTO exports VALUES (?,?,?)', updates)
                self._export_metadata_error = None
            except sqlite3.Error as exc:
                # Conservative: leave old export revisions, report pending rather
                # than turn a committed correction into an apparent failed approval.
                self._export_metadata_error = str(exc)
            return self.export_status()

    def check_original(self):
        changed = [name for name, digest in self.manifest['source_files'].items() if not (self.source/name).is_file() or sha(self.source/name) != digest]
        if changed:
            raise ValueError(f'Original files changed: {changed}')
        return {'unchanged_source_files': len(self.manifest['source_files'])}

    def get_item(self, ref):
        with self.lock:
            revision, doc, reviews = self.current()
            item = resolve(doc, ref)
            return {'asset_id': self.manifest['asset_id'], 'revision': revision, 'item': item, 'original': resolve(self.original, ref), 'reviews': {k:v for k,v in reviews.items() if k == ref or k.startswith(ref+'/cells/')}, 'locations': self.locations(doc, item), 'target_version': self._last_changes().get(ref, 0)}

    def locations(self, doc, item, cell=None):
        locations = []
        if cell is not None and len(item.get('prov', [])) != 1:
            return []  # TableCell has no page_no. Multi-provenance tables are ambiguous.
        for prov in item.get('prov', []):
            page = doc['pages'][str(prov['page_no'])]
            bbox = item['data']['table_cells'][cell].get('bbox') if cell is not None else prov['bbox']
            if bbox:
                locations.append({'page': prov['page_no'], 'bbox': bbox, 'rect': rect(bbox, page['size']), 'size': page['size'], 'image': '/asset/'+page['image']['uri']})
        return locations

    def _proposal(self, proposal_id):
        row = self.db.execute('SELECT payload FROM proposals WHERE id=?', (proposal_id,)).fetchone()
        if not row:
            raise ValueError('Unknown proposal')
        return json.loads(row[0])

    def _last_changes(self):
        # Both apply and undo touch the item. This also detects ABA (changed back
        # to the same value) and review-only decisions with identical text.
        touched = {}
        for seq, payload in self.db.execute('SELECT seq,payload FROM history'):
            event = json.loads(payload)
            for ref in event.get('refs', [event['ref']]):
                touched[ref] = max(seq, touched.get(ref, -1))
        return touched

    def _proposal_view(self, proposal, revision, doc, touched):
        p = copy.deepcopy(proposal)
        p['current_revision'] = revision
        if p['status'] == 'pending':
            ref = p['request']['ref']
            current_item = resolve(doc, ref)
            if (p['request']['revision'] > revision or
                    touched.get(ref, -1) > p['request']['revision'] or current_item != p['before']):
                p['status'] = 'stale'
                p['stale_reason'] = '대상 항목의 내용 또는 검수 이력이 바뀌었습니다. 최신 내용으로 재제안이 필요합니다.'
                p['current_before'] = copy.deepcopy(current_item)
        return p

    def proposals(self):
        with self.lock:
            revision, doc, _ = self.current()
            touched = self._last_changes()
            events = self.history()
            applied = {e['seq']: e['proposal'] for e in events if e['kind'] == 'apply'}
            undone = {applied[e['undoes']]: e['seq'] for e in events
                      if e['kind'] == 'undo' and e['undoes'] in applied}
            result = [self._proposal_view(json.loads(r[0]), revision, doc, touched)
                      for r in self.db.execute('SELECT payload FROM proposals ORDER BY rowid DESC')]
            for p in result:
                if p['id'] in undone:
                    p['undone_revision'] = undone[p['id']]
            return result

    def history(self):
        return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM history ORDER BY seq DESC')]

    def prepare(self, doc, req):
        ref, op = req['ref'], req['op']
        operation_fields = {'text': {'value'}, 'type': {'value', 'level'}, 'cell': {'value', 'cell'}, 'keep': {'cell', 'value'}, 'defer': {'cell', 'value'}}
        if op not in operation_fields:
            raise ValueError('Unsupported operation; structural edits are refused')
        if set(req) - ({'asset_id', 'revision', 'ref', 'op', 'reason'} | operation_fields[op]):
            raise ValueError('Unsupported proposal fields; arbitrary JSON patches are refused')
        item = resolve(doc, ref)
        if ref not in {v['self_ref'] for v in items(doc)}:
            raise ValueError('Only document items can be reviewed')
        result = copy.deepcopy(item)
        scope = ref
        if op == 'text':
            if not ref.startswith('#/texts/') or item.get('children'):
                raise ValueError('Text correction requires a leaf text item')
            if len(item.get('prov', [])) != 1:
                raise ValueError('Multi-provenance text correction requires explicit span mapping; unsupported')
            if not isinstance(req.get('value'), str):
                raise ValueError('Text value must be a string')
            result['text'] = req['value']
            result['prov'][0]['charspan'] = [0, len(req['value'])]
        elif op == 'type':
            if not ref.startswith('#/texts/') or item['label'] not in TYPE_LABELS or req.get('value') not in TYPE_LABELS or item.get('children'):
                raise ValueError('Supported type corrections: leaf text/paragraph/title/section_header/page_header/page_footer only')
            result['label'] = req['value']
            if req['value'] == 'section_header':
                if type(req.get('level')) is not int or not 1 <= req['level'] <= 6:
                    raise ValueError('section_header requires explicit level 1..6')
                result['level'] = req['level']
            else:
                result.pop('level', None)
        elif op == 'cell':
            cell = req.get('cell')
            if not ref.startswith('#/tables/') or type(cell) is not int or not 0 <= cell < len(item['data']['table_cells']):
                raise ValueError('Invalid table cell index')
            if not isinstance(req.get('value'), str) or 'ref' in item['data']['table_cells'][cell]:
                raise ValueError('Only plain table cell text is supported')
            result['data']['table_cells'][cell]['text'] = req['value']
            scope += f'/cells/{cell}'
        elif op in ('keep', 'defer'):
            if req.get('cell') is not None:
                cell = req['cell']
                if not ref.startswith('#/tables/') or type(cell) is not int or not 0 <= cell < len(item['data']['table_cells']):
                    raise ValueError('Invalid table cell index')
                scope += f'/cells/{cell}'
        else:
            raise ValueError('Unsupported operation; split/merge/delete/reorder and table structure edits are refused')
        if op not in ('keep', 'defer') and result == item:
            raise ValueError('Proposal makes no change')
        candidate = copy.deepcopy(doc)
        target = resolve(candidate, ref)
        target.clear()
        target.update(result)
        validate(candidate)
        return scope, copy.deepcopy(item), result

    def propose(self, req, request_id=None):
        with self.lock:
            fingerprint = json.dumps(req, sort_keys=True, ensure_ascii=False)
            if request_id is not None:
                if not isinstance(request_id, str) or not 8 <= len(request_id) <= 100:
                    raise ValueError('Invalid proposal request ID')
                row = self.db.execute('SELECT fingerprint,proposal FROM proposal_requests WHERE id=?', (request_id,)).fetchone()
                if row:
                    if row[0] != fingerprint:
                        raise ValueError('Request ID reused with different proposal')
                    return self._proposal(row[1])
            revision, doc, reviews = self.current()
            if req.get('revision') != revision or req.get('asset_id') != self.manifest['asset_id']:
                raise ValueError('Asset/revision mismatch; fetch current item again')
            if not str(req.get('reason', '')).strip():
                raise ValueError('Explain suspicion and proposal; reason is required')
            scope, before, after = self.prepare(doc, req)
            p = {'id': uuid.uuid4().hex[:12], 'status': 'pending', 'request': req, 'scope': scope, 'before': before, 'after': after, 'created': datetime.now(timezone.utc).isoformat()}
            with self.db:
                self.db.execute('INSERT INTO proposals VALUES (?,?)', (p['id'], dump(p)))
                if request_id is not None:
                    self.db.execute('INSERT INTO proposal_requests VALUES (?,?,?)', (request_id, fingerprint, p['id']))
            return p

    def repropose(self, proposal_id, expected_revision):
        """Create a new unapproved proposal from an explicitly inspected revision."""
        with self.lock:
            revision, doc, _ = self.current()
            old = self._proposal(proposal_id)
            view = self._proposal_view(old, revision, doc, self._last_changes())
            if expected_revision != revision:
                raise ProposalConflict('Revision changed; inspect the latest proposal again', view)
            if view['status'] != 'stale':
                raise ProposalConflict('Only stale proposals can be reproposed', view)
            req = {**old['request'], 'revision': revision}
            scope, before, after = self.prepare(doc, req)
            new = {'id': uuid.uuid4().hex[:12], 'status': 'pending', 'request': req,
                   'scope': scope, 'before': before, 'after': after, 'replaces': proposal_id,
                   'created': datetime.now(timezone.utc).isoformat()}
            old['status'] = 'superseded'
            old['superseded_by'] = new['id']
            with self.db:
                self.db.execute('INSERT INTO proposals VALUES (?,?)', (new['id'], dump(new)))
                self.db.execute('UPDATE proposals SET payload=? WHERE id=?', (dump(old), proposal_id))
            return new

    def decide(self, proposal_id, action):
        with self.lock:
            p = self._proposal(proposal_id)
            if p['status'] != 'pending':
                raise ProposalConflict('Proposal already decided', p)
            if action == 'reject':
                p['status'] = 'rejected'
                with self.db:
                    self.db.execute('UPDATE proposals SET payload=? WHERE id=?', (dump(p), proposal_id))
                return p
            if action != 'approve':
                raise ValueError('Unknown decision')
            revision, doc, reviews = self.current()
            view = self._proposal_view(p, revision, doc, self._last_changes())
            if view['status'] == 'stale':
                raise ProposalConflict('Stale proposal; inspect latest data and create a new proposal', view)
            self.check_original()
            scope, before, after = self.prepare(doc, p['request'])
            target = resolve(doc, p['request']['ref'])
            target.clear()
            target.update(after)
            validate(doc)
            old_reviews = copy.deepcopy(reviews)
            if p['request']['op'] == 'cell':
                reviews.pop(p['request']['ref'], None)
            state = {'keep': 'kept', 'defer': 'deferred'}.get(p['request']['op'], 'corrected_partial')
            reviews[scope] = {'state': state, 'reason': p['request']['reason'], 'proposal': proposal_id, 'revision': revision+1}
            p['status'] = 'applied'
            event = {'seq': revision+1, 'kind': 'apply', 'proposal': proposal_id, 'ref': p['request']['ref'], 'scope': scope, 'before': before, 'after': after, 'reviews_before': old_reviews, 'reviews_after': reviews, 'time': datetime.now(timezone.utc).isoformat()}
            with self.db:
                self.db.execute('UPDATE current SET revision=?,document=?,reviews=? WHERE id=1', (revision+1, dump(doc), dump(reviews)))
                self.db.execute('UPDATE proposals SET payload=? WHERE id=?', (dump(p), proposal_id))
                self.db.execute('INSERT INTO history VALUES (?,?)', (revision+1, dump(event)))
            return {**event, 'committed': True, 'export': self.export()}

    def undo(self, expected_revision):
        with self.lock:
            revision, doc, reviews = self.current()
            if expected_revision != revision:
                raise ValueError('Revision changed; refresh before undo')
            events = self.history()
            undone = {e['undoes'] for e in events if e['kind'] == 'undo'}
            event = next((e for e in events if e['kind'] == 'apply' and e['seq'] not in undone), None)
            if not event:
                raise ValueError('Nothing to undo')
            targets = event.get('batch', [event])
            if any(resolve(doc, t['ref']) != t['after'] for t in targets):
                raise ValueError('Undo conflict; nothing changed')
            self.check_original()
            for t in targets:
                target = resolve(doc, t['ref'])
                target.clear()
                target.update(t['before'])
            validate(doc)
            reversal = {'seq': revision+1, 'kind': 'undo', 'undoes': event['seq'], 'ref': event['ref'], 'before': event['after'], 'after': event['before'], 'time': datetime.now(timezone.utc).isoformat()}
            if 'batch' in event:
                reversal['refs'] = event['refs']
                reversal['batch'] = [{'ref': t['ref'], 'before': t['after'], 'after': t['before']} for t in targets]
            with self.db:
                if 'batch' in event:
                    for key, value in event['decisions_before'].items():
                        if value is None:
                            self.db.execute('DELETE FROM diagnostic_decisions WHERE id=?', (key,))
                        else:
                            self.db.execute('INSERT OR REPLACE INTO diagnostic_decisions VALUES(?,?)', (key, dump(value)))
                    row = self.db.execute('SELECT payload FROM batches WHERE id=?', (event['proposal'],)).fetchone()
                    payload = json.loads(row[0]); payload['status'] = 'undone'; payload['undone_revision'] = revision+1
                    self.db.execute('UPDATE batches SET payload=? WHERE id=?', (dump(payload), event['proposal']))
                self.db.execute('UPDATE current SET revision=?,document=?,reviews=? WHERE id=1', (revision+1, dump(doc), dump(event['reviews_before'])))
                self.db.execute('INSERT INTO history VALUES (?,?)', (revision+1, dump(reversal)))
            return {**reversal, 'committed': True, 'export': self.export()}

    def suspects(self):
        _, doc, reviews = self.current()
        found = []
        for v in items(doc):
            reasons = []
            if v.get('label') == 'formula':
                reasons.append('수식 항목: 기호·첨자·읽기 순서를 원본에서 확인 필요')
            if 'text' in v and not v['text'].strip() and not v.get('children'):
                reasons.append('빈 텍스트: 누락인지 원본 확인 필요')
            if '\ufffd' in v.get('text', ''):
                reasons.append('유니코드 대체 문자 발견')
            if len(v.get('prov', [])) > 1:
                reasons.append('여러 원본 영역 연결: 읽기 순서·연속성 확인 필요')
            if v['self_ref'].startswith('#/tables/'):
                occupied = set()
                for c in v['data']['table_cells']:
                    positions = {(r,col) for r in range(c['start_row_offset_idx'],c['end_row_offset_idx']) for col in range(c['start_col_offset_idx'],c['end_col_offset_idx'])}
                    if occupied & positions:
                        reasons.append('표 셀 행·열 범위가 겹침: 구조 수정은 MVP 미지원, 원본 확인 후 보류 가능')
                        break
                    occupied |= positions
            if reasons:
                found.append({'ref': v['self_ref'], 'page': v['prov'][0]['page_no'] if v.get('prov') else None, 'reasons': reasons, 'review': {'state': review_state(reviews, v['self_ref'])}})
        return found
