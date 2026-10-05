"""MVP evaluation regressions. Every write targets an isolated temporary Asset."""
import copy
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from candoc import core
from candoc.core import ROOT, Store, initialize
from candoc.server import make_server


class EvaluationRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='candoc-regressions-')
        cls.template = Path(cls.temp.name)/'template'
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip', cls.template)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.data = Path(self.temp.name)/self._testMethodName
        shutil.copytree(self.template, self.data)
        self.store = Store(self.data)

    def tearDown(self):
        self.store.close()

    def proposal(self, ref='#/texts/0', value='Isolated correction', op='text', **kw):
        return self.store.propose({'asset_id': self.store.manifest['asset_id'],
            'revision': self.store.current()[0], 'ref': ref, 'op': op,
            'value': value, 'reason': 'Isolated regression test', **kw})

    def test_export_failure_keeps_committed_state_and_retry_does_not_reapply(self):
        proposal = self.proposal()
        before = (self.data/'work/document.json').read_bytes()
        real_atomic = core.atomic

        def fail_document(path, content):
            if Path(path).name == 'document.json':
                raise PermissionError('Injected export failure')
            return real_atomic(path, content)

        with patch.object(core, 'atomic', side_effect=fail_document):
            result = self.store.decide(proposal['id'], 'approve')
            self.assertTrue(result['committed'])
            self.assertEqual(result['export']['state'], 'pending')
            self.assertEqual(result['export']['db_revision'], 1)
            self.assertEqual(result['export']['files']['document.json'], 0)
            self.assertEqual(result['export']['files']['review.json'], 1)
            self.assertEqual(self.store.export()['state'], 'pending')
            self.assertEqual((self.data/'work/document.json').read_bytes(), before)
        self.assertEqual(self.store.proposals()[0]['status'], 'applied')
        with self.assertRaisesRegex(ValueError, 'already decided'):
            self.store.decide(proposal['id'], 'approve')
        self.assertEqual(self.store.current()[0], 1)
        self.assertEqual(len(self.store.history()), 1)
        self.assertEqual(self.store.export()['state'], 'synced')
        self.assertEqual(self.store.export()['state'], 'synced')
        self.assertEqual(json.loads((self.data/'work/document.json').read_text('utf-8')), self.store.current()[1])
        self.assertEqual(self.store.current()[0], 1)
        self.store.close()
        self.store = Store(self.data)
        self.assertEqual(self.store.current()[1]['texts'][0]['text'], 'Isolated correction')
        self.store.undo(1)
        self.assertEqual(self.store.current()[1], self.store.original)

    def test_independent_proposals_survive_other_item_approval(self):
        a = self.proposal('#/texts/0', 'First item')
        b = self.proposal('#/texts/1', 'Second item')
        self.store.decide(a['id'], 'approve')
        self.assertEqual(next(p for p in self.store.proposals() if p['id']==b['id'])['status'], 'pending')
        self.store.decide(b['id'], 'approve')
        revision, doc, _ = self.store.current()
        self.assertEqual(revision, 2)
        self.assertEqual(doc['texts'][0]['text'], 'First item')
        self.assertEqual(doc['texts'][1]['text'], 'Second item')
        # The original basis is preserved, not rewritten to bypass concurrency.
        self.assertEqual(next(p for p in self.store.proposals() if p['id']==b['id'])['request']['revision'], 0)

    def test_same_item_stale_reproposal_is_new_and_requires_separate_approval(self):
        a = self.proposal(value='Approved new text')
        old = self.proposal(op='type', value='section_header', level=2)
        self.store.decide(a['id'], 'approve')
        stale = next(p for p in self.store.proposals() if p['id'] == old['id'])
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual(stale['current_before']['text'], 'Approved new text')
        with self.assertRaisesRegex(ValueError, 'Stale'):
            self.store.decide(old['id'], 'approve')
        with self.assertRaisesRegex(ValueError, 'Revision changed'):
            self.store.repropose(old['id'], 0)
        new = self.store.repropose(old['id'], 1)
        self.assertNotEqual(new['id'], old['id'])
        self.assertEqual(new['before']['text'], 'Approved new text')
        self.assertEqual(new['after']['text'], 'Approved new text')
        self.assertEqual(new['replaces'], old['id'])
        self.assertEqual(new['status'], 'pending')
        self.assertEqual(self.store.current()[0], 1)
        old_record = next(p for p in self.store.proposals() if p['id'] == old['id'])
        self.assertEqual(old_record['status'], 'superseded')
        self.assertEqual(old_record['request']['revision'], 0)
        with self.assertRaisesRegex(ValueError, 'already decided'):
            self.store.decide(old['id'], 'approve')
        self.store.decide(new['id'], 'approve')
        self.assertEqual(self.store.current()[1]['texts'][0]['text'], 'Approved new text')
        self.assertEqual(self.store.current()[1]['texts'][0]['level'], 2)
        self.store.undo(2)
        self.store.undo(3)
        self.assertEqual(self.store.current()[1], self.store.original)

    def test_review_only_and_aba_changes_are_conflicts(self):
        keep = self.proposal(op='keep', value=None)
        old = self.proposal()
        self.store.decide(keep['id'], 'approve')
        self.assertEqual(self.store.current()[1], self.store.original)
        self.assertEqual(next(p for p in self.store.proposals() if p['id']==old['id'])['status'], 'stale')
        self.store.undo(1)
        self.assertEqual(self.store.current()[2], {})
        # Same values do not erase the intervening decision/undo history.
        with self.assertRaisesRegex(ValueError, 'Stale'):
            self.store.decide(old['id'], 'approve')
        new = self.store.repropose(old['id'], 2)
        self.store.decide(new['id'], 'approve')
        self.assertEqual(self.store.current()[0], 3)

    def test_parallel_decisions_do_not_lose_updates(self):
        a = self.proposal('#/texts/0', 'Parallel first')
        b = self.proposal('#/texts/1', 'Parallel second')
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda p: self.store.decide(p['id'], 'approve'), [a,b]))
        self.assertEqual({r['seq'] for r in results}, {1,2})
        self.assertEqual(self.store.current()[1]['texts'][0]['text'], 'Parallel first')
        self.assertEqual(self.store.current()[1]['texts'][1]['text'], 'Parallel second')
        same_a = self.proposal(value='Competing A')
        same_b = self.proposal(value='Competing B')
        def attempt(p):
            try:
                self.store.decide(p['id'], 'approve')
                return 'applied'
            except core.ProposalConflict:
                return 'stale'
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(attempt, [same_a,same_b]))
        self.assertCountEqual(outcomes, ['applied','stale'])
        self.assertEqual(self.store.current()[0], 3)

    def test_partial_export_restart_and_latest_snapshot_retry(self):
        real_atomic = core.atomic
        def fail_review(path, content):
            if Path(path).name == 'review.json':
                raise OSError('Injected review export failure')
            return real_atomic(path, content)
        a = self.proposal(value='First committed value')
        with patch.object(core, 'atomic', side_effect=fail_review):
            result = self.store.decide(a['id'], 'approve')
            self.assertEqual(result['export']['files'], {'document.json': 1, 'review.json': 0})
            self.store.close()
            self.store = Store(self.data)  # Persistent export failure must not prevent recovery UI.
            self.assertEqual(self.store.export_status()['state'], 'pending')
            b = self.proposal('#/texts/1', 'Second committed value')
            self.store.decide(b['id'], 'approve')
            undone = self.store.undo(2)
            self.assertTrue(undone['committed'])
            self.assertEqual(undone['export']['state'], 'pending')
        result = self.store.export()
        self.assertEqual(result['files'], {'document.json': 3, 'review.json': 3})
        saved = json.loads((self.data/'work/document.json').read_text('utf-8'))
        self.assertEqual(saved['texts'][0]['text'], 'First committed value')
        self.assertEqual(saved['texts'][1], self.store.original['texts'][1])
        self.assertEqual(json.loads((self.data/'work/review.json').read_text('utf-8')), self.store.current()[2])
        self.assertEqual(len(self.store.history()), 3)

    def test_replace_failure_preserves_previous_file_and_cleans_temp(self):
        p = self.proposal()
        before = (self.data/'work/document.json').read_bytes()
        replace = core.os.replace
        def fail_replace(src, dest):
            if Path(dest).name == 'document.json':
                raise PermissionError('Injected os.replace denial')
            return replace(src, dest)
        with patch.object(core.os, 'replace', side_effect=fail_replace):
            self.assertTrue(self.store.decide(p['id'], 'approve')['committed'])
        self.assertEqual((self.data/'work/document.json').read_bytes(), before)
        self.assertEqual(list((self.data/'work').glob('*.tmp')), [])
        self.assertEqual(self.store.export()['state'], 'synced')

    def test_database_rejection_is_not_reported_as_committed(self):
        p = self.proposal()
        self.store.db.execute("CREATE TEMP TRIGGER refuse_change BEFORE UPDATE OF revision ON current BEGIN SELECT RAISE(ABORT, 'Injected database failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.decide(p['id'], 'approve')
        self.assertEqual(self.store.current()[0], 0)
        self.assertEqual(self.store.proposals()[0]['status'], 'pending')
        self.assertEqual(self.store.history(), [])
        self.assertEqual(self.store.export_status()['state'], 'synced')

    def test_export_metadata_failure_remains_a_committed_pending_result(self):
        p = self.proposal()
        self.store.db.execute("CREATE TEMP TRIGGER refuse_export BEFORE INSERT ON exports BEGIN SELECT RAISE(ABORT, 'Injected export status write failure'); END")
        result = self.store.decide(p['id'], 'approve')
        self.assertTrue(result['committed'])
        self.assertEqual(result['export']['state'], 'pending')
        self.assertIn('status', result['export']['errors'])
        self.assertEqual(self.store.current()[0], 1)
        self.store.db.execute('DROP TRIGGER refuse_export')
        self.assertEqual(self.store.export()['state'], 'synced')
        self.assertEqual(len(self.store.history()), 1)

    def test_legacy_database_preserves_corrections_proposals_and_history(self):
        applied = self.proposal(value='Existing approved correction')
        self.store.decide(applied['id'], 'approve')
        self.proposal('#/texts/1', 'Existing unapproved proposal')
        before = self.store.current()
        proposals = self.store.db.execute('SELECT id,payload FROM proposals ORDER BY id').fetchall()
        history = self.store.history()
        self.store.db.execute('DROP TABLE exports')  # Original MVP database schema.
        self.store.close()
        self.store = Store(self.data)
        self.assertEqual(self.store.current(), before)
        self.assertEqual(self.store.db.execute('SELECT id,payload FROM proposals ORDER BY id').fetchall(), proposals)
        self.assertEqual(self.store.history(), history)
        self.assertEqual(self.store.export_status()['state'], 'synced')
        self.assertEqual(json.loads((self.data/'work/document.json').read_text('utf-8')), before[1])

    def test_http_and_cli_report_committed_export_pending_and_retry(self):
        self.store.close()
        server = make_server(self.data, 0)
        self.store = server.store
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def api(path, data=None):
            headers = {'Content-Type': 'application/json'}
            if data is not None:
                headers['X-Candoc-Token'] = token
            with urlopen(Request(base+'/api/'+path, headers=headers,
                    data=None if data is None else json.dumps(data).encode()), timeout=30) as response:
                return response.status, json.load(response)
        def cli(*args):
            return subprocess.run([sys.executable,'-m','candoc.cli','--url',base,*args],
                                  cwd=ROOT,capture_output=True,text=True,encoding='utf-8',timeout=30)
        try:
            token = api('bootstrap')[1]['token']
            p = self.proposal()
            with patch.object(core, 'atomic', side_effect=PermissionError('Injected all exports failure')):
                code, result = api('decision', {'id':p['id'],'action':'approve'})
                self.assertEqual(code, 200)
                self.assertTrue(result['committed'])
                self.assertEqual(api('bootstrap')[1]['revision'], 1)
                self.assertEqual(api('bootstrap')[1]['export']['state'], 'pending')
                with self.assertRaises(HTTPError) as conflict:
                    api('decision', {'id':p['id'],'action':'approve'})
                self.assertEqual(conflict.exception.code, 409)
                body = json.load(conflict.exception)
                self.assertEqual(body['proposal']['status'], 'applied')
                self.assertEqual(body['export']['db_revision'], 1)
                failure = cli('reexport')
                self.assertEqual(failure.returncode, 2, failure.stderr)
                self.assertEqual(json.loads(failure.stdout)['state'], 'pending')
            retry = cli('reexport')
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertEqual(json.loads(retry.stdout)['state'], 'synced')
            self.assertEqual(api('bootstrap')[1]['revision'], 1)
            self.assertEqual(len(api('history')[1]), 1)
            first = self.proposal(value='HTTP competing update')
            old = self.proposal(op='type', value='section_header', level=2)
            api('decision', {'id':first['id'],'action':'approve'})
            rejected = cli('repropose', old['id'], '--revision', '1')
            self.assertEqual(rejected.returncode, 1)
            fresh = cli('repropose', old['id'], '--revision', '2')
            self.assertEqual(fresh.returncode, 0, fresh.stderr)
            new = json.loads(fresh.stdout)
            self.assertEqual(new['status'], 'pending')
            self.assertEqual(new['before']['text'], 'HTTP competing update')
            self.assertEqual(api('bootstrap')[1]['revision'], 2)
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
