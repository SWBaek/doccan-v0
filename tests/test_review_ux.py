"""Continuous-review regressions. No writes to the real Asset."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen

from candoc.core import ROOT, Store, initialize, items
from candoc.review import edit_capability, review_state, search_items
from candoc.server import make_server


class ReviewUX(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='candoc-ux-')
        cls.data = Path(cls.temp.name)/'data'
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip', cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_table_judgment_then_cell_defer_and_undo_preserve_history(self):
        store = Store(self.data)
        try:
            def approve(op, cell=None):
                req = dict(asset_id=store.manifest['asset_id'], revision=store.current()[0],
                           ref='#/tables/0', op=op, reason='Isolated judgment test', cell=cell)
                p = store.propose(req)
                store.decide(p['id'], 'approve')
            approve('keep')
            whole = copy.deepcopy(store.current()[2]['#/tables/0'])
            approve('defer', 0)
            reviews = store.current()[2]
            self.assertEqual(reviews['#/tables/0'], whole)
            self.assertEqual(review_state(reviews, '#/tables/0'), 'deferred')
            self.assertEqual(review_state(reviews, '#/tables/0', 0), 'deferred')
            self.assertEqual(review_state(reviews, '#/tables/0', 1), 'unreviewed')
            snapshot = copy.deepcopy(reviews)
            review_state(reviews, '#/tables/0')
            self.assertEqual(reviews, snapshot)
            store.undo(store.current()[0])
            self.assertEqual(review_state(store.current()[2], '#/tables/0'), 'kept')
            store.undo(store.current()[0])
        finally:
            store.close()

    def test_explicit_whole_judgment_supersedes_older_cell_only_for_display(self):
        reviews = {'#/tables/0': {'state': 'kept', 'revision': 5},
                   '#/tables/0/cells/0': {'state': 'deferred', 'revision': 3}}
        self.assertEqual(review_state(reviews, '#/tables/0'), 'kept')
        del reviews['#/tables/0']
        reviews['#/tables/0/cells/0']['state'] = 'kept'
        self.assertEqual(review_state(reviews, '#/tables/0'), 'unreviewed')
        reviews['#/tables/0/cells/0']['state'] = 'corrected_partial'
        self.assertEqual(review_state(reviews, '#/tables/0'), 'corrected_partial')

    def test_search_exact_cells_context_and_unknown_page(self):
        doc = json.loads((self.data/'source/document.json').read_text('utf-8'))
        hits = search_items(items(doc), 'Basso')
        cell = next(h for h in hits if h['ref'] == '#/tables/0' and h['cell'] == 0)
        self.assertIn('Basso', cell['text'])
        self.assertEqual((cell['row'], cell['column'], cell['page']), (1, 1, 7))
        table = copy.deepcopy(doc['tables'][0])
        table['prov'].append(copy.deepcopy(table['prov'][0]))
        ambiguous = search_items([table], 'Basso')[0]
        self.assertIsNone(ambiguous['page'])
        self.assertTrue(ambiguous['location_note'])
        text = copy.deepcopy(doc['texts'][0])
        text['text'] = 'a'*500+'EXACT MATCH'+'b'*400
        hit = search_items([text], 'exact match')[0]
        self.assertIn('EXACT MATCH', hit['text'])
        self.assertLess(len(hit['text']), 240)
        self.assertEqual(search_items([text], ''), [])

    def test_capability_matches_existing_backend_constraints(self):
        doc = json.loads((self.data/'source/document.json').read_text('utf-8'))
        self.assertEqual(edit_capability(doc['texts'][0])['op'], 'text')
        self.assertIsNone(edit_capability(doc['tables'][0])['op'])
        self.assertEqual(edit_capability(doc['tables'][0], 0)['op'], 'cell')
        rich = copy.deepcopy(doc['tables'][0])
        rich['data']['table_cells'][0]['ref'] = {'$ref': '#/texts/0'}
        self.assertIsNone(edit_capability(rich, 0)['op'])
        multi = copy.deepcopy(doc['texts'][0])
        multi['prov'] *= 2
        self.assertIsNone(edit_capability(multi)['op'])

    def test_http_pagination_and_durable_idempotent_creation(self):
        server = make_server(self.data, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}/api/'
        def get(path):
            with urlopen(base+path) as r:
                return json.load(r)
        try:
            boot = get('bootstrap')
            all_hits = get('search?q=the')
            first = get('search?q=the&offset=0&limit=150')
            tail = get('search?q=the&offset=150&limit=150')
            self.assertGreater(first['total'], 150)
            self.assertEqual(first['items']+tail['items'], all_hits[:300])
            req = dict(asset_id=boot['asset']['asset_id'], revision=boot['revision'],
                       ref='#/texts/0', op='text', value='Isolated human proposal', reason='Test exact approval',
                       request_id='durable-human-request')
            def post():
                with urlopen(Request(base+'propose', data=json.dumps(req).encode(),
                             headers={'Content-Type': 'application/json', 'X-Candoc-Token': boot['token']})) as r:
                    return json.load(r)
            with ThreadPoolExecutor(max_workers=2) as pool:
                a, b = list(pool.map(lambda _: post(), range(2)))
            self.assertEqual(a['id'], b['id'])
            self.assertEqual(get('bootstrap')['revision'], boot['revision'])
            self.assertNotEqual(get('document')['texts'][0]['text'], req['value'])
            server.store.decide(a['id'], 'approve')
            self.assertEqual(post()['status'], 'applied')
            self.assertEqual(get('bootstrap')['revision'], boot['revision']+1)
            server.store.undo(boot['revision']+1)
            undone = next(p for p in get('proposals') if p['id'] == a['id'])
            self.assertEqual(undone['status'], 'applied')  # historical approval is retained
            self.assertEqual(undone['undone_revision'], boot['revision']+2)
        finally:
            server.shutdown(); server.server_close(); server.store.close(); thread.join()
        store = Store(self.data)
        try:
            body = {k:v for k,v in req.items() if k != 'request_id'}
            self.assertEqual(store.propose(body, req['request_id'])['id'], a['id'])
            with self.assertRaisesRegex(ValueError, 'different proposal'):
                store.propose({**body, 'value': 'different'}, req['request_id'])
        finally:
            store.close()
