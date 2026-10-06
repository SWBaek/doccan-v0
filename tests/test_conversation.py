"""Conversation safety on isolated Assets; synthetic model responses only."""
import copy
import json
import shutil
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from candoc import core
from candoc.core import ROOT, Store, initialize
from candoc.batch import BatchReview
from candoc.conversation import Conversation
from candoc.codex_rpc import StdioRPC


def wait(fn, seconds=25):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=fn()
        if value:return value
        time.sleep(.05)
    raise AssertionError('Timed out')


class ConversationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='candoc-conversation-')
        cls.root=Path(cls.temp.name)
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip',cls.root/'template')

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def setUp(self):
        self.dir=self.root/self._testMethodName
        shutil.copytree(self.root/'template',self.dir/'asset')
        self.settings={'state_dir':self.dir/'chat','project_dir':ROOT,'codex_executable':'synthetic','model':None}
        self.scenario='normal'
        self.open()
        self.original=self.store.current()[1]

    def factory(self,exe,cwd,on_event,on_request,on_exit,*,overrides=None):
        return StdioRPC(exe,cwd,on_event,on_request,on_exit,timeout=5,
            command=[sys.executable,str(ROOT/'tests/fake_codex.py'),'--state',str(self.dir/'fake'),
                '--scenario',self.scenario,'--overrides',json.dumps(overrides or {})])

    def open(self):
        self.store=Store(self.dir/'asset');self.batch=BatchReview(self.store);self.store.batch=self.batch
        self.c=Conversation(self.store,self.batch,self.settings,self.factory)

    def close(self):self.c.close();self.batch.close();self.store.close()
    def tearDown(self):self.close()
    def terminal(self):return wait(lambda:self.c.state() if self.c.s['mode'] in ('awaiting','discussing','error') else None)

    def start(self):
        self.c.models();self.c.configure({'model':'mock-a','effort':'medium'})
        self.c.control({'action':'start'})
        s=self.terminal();self.assertEqual(s['mode'],'awaiting',s['note']);return s

    def request(self,text,**kw):
        s=self.c.state();o=s['current'];c=o['context'] if o else s['context']
        context={k:c[k] for k in ('asset_id','revision','ref','cell')}
        if c.get('group_id'):context['group_id']=c['group_id']
        return dict(id=str(uuid.uuid4()),message=text,presentation=o['id'] if o else None,
            generation=s['generation'],context=context,inspect=False,**kw)

    def test_models_official_pagination_effort_on_wire_and_no_fallback(self):
        result=self.c.models();self.assertEqual([m['model'] for m in result['models']],['mock-a','mock-b'])
        with self.assertRaises(ValueError):self.c.configure({'model':'mock-b','effort':'low'})
        self.start()
        wire=[json.loads(l) for l in (self.dir/'fake/wire.jsonl').read_text('utf-8').splitlines()]
        turn=next(m['params'] for m in wire if m.get('method')=='turn/start')
        self.assertEqual((turn['model'],turn['effort']),('mock-a','medium'))
        self.assertEqual(turn['environments'],[])
        self.c.chat.disconnect();self.scenario='models_fail'
        with self.assertRaises(Exception):self.c.models()
        self.assertEqual(self.store.current()[0],0)

    def test_user_scope_is_new_proposal_idempotent_and_requires_new_approval(self):
        s=self.start();first=s['current'];old_approval=self.request('응')
        change=dict(action='scope',offer=first['id'],generation=s['generation'],refs=first['refs'][:-2],request_id=str(uuid.uuid4()))
        changed=self.c.control(change);new=changed['current']
        self.assertEqual(len(new['refs']),len(first['refs'])-2)
        self.assertNotEqual(new['id'],first['id']);self.assertEqual(self.store.current()[0],0)
        self.assertEqual(self.c.control(change)['current']['id'],new['id'])
        with self.assertRaises(ValueError):self.c.control({**change,'refs':first['refs']})
        self.c.message(old_approval);self.assertEqual(self.store.current()[0],0)
        restored=self.c.control(dict(action='scope',offer=new['id'],generation=changed['generation'],refs=first['refs'],request_id=str(uuid.uuid4())))
        self.assertEqual(restored['current']['refs'],first['refs'])
        self.close();self.open();self.assertEqual(self.c.state()['current']['id'],restored['current']['id'])
        self.c.control({'action':'resume'});self.c.control({'action':'present','offer':restored['current']['id']})
        approval=self.request('승인해');self.c.message(approval);self.c.control({'action':'pause'})
        self.assertEqual(self.store.current()[0],1)
        self.c.message(approval);self.c.control(change);self.assertEqual(self.store.current()[0],1)
        receipt=next(m['result'] for m in self.c.state()['messages'] if m['id']==approval['id'])
        self.assertEqual(receipt['count'],len(first['refs']));self.assertEqual(receipt['decision'],'approve')
        self.store.undo(1);self.assertEqual(self.store.current()[1],self.original)

    def test_scope_rejects_empty_foreign_paused_old_and_changed_targets(self):
        s=self.start();o=s['current']
        def scope(refs,**kwargs):return dict(action='scope',offer=o['id'],generation=s['generation'],refs=refs,request_id=str(uuid.uuid4()),**kwargs)
        for refs in ([],['#/texts/0'],[o['refs'][0],o['refs'][0]]):
            with self.assertRaises(ValueError):self.c.control(scope(refs))
        self.c.control({'action':'pause'})
        with self.assertRaises(ValueError):self.c.control(scope(o['refs'][:-1]))
        self.c.control({'action':'resume'})
        self.c.control({'action':'present','offer':o['id']})
        with self.assertRaises(ValueError):self.c.control(scope(o['refs'][:-1]))
        s=self.c.state()
        p=self.store.propose(dict(asset_id=self.store.manifest['asset_id'],revision=0,ref=o['refs'][0],op='keep',reason='isolated conflict'))
        self.store.decide(p['id'],'approve')
        with self.assertRaises(ValueError):self.c.control(scope(o['refs'][1:]))
        self.assertEqual(self.store.current()[0],1)
        self.store.undo(1);self.assertEqual(self.store.current()[1],self.original)

    def test_start_explain_exception_clear_approval_receipt_and_undo(self):
        s=self.start();p=s['current']['proposal'];self.assertGreater(len(p['targets']),3)
        self.assertEqual(self.store.current()[0],0)
        self.c.message(self.request('왜 그렇게 생각해?'))
        s=self.terminal();self.assertEqual(s['mode'],'discussing')
        self.c.message(self.request('응')) # acknowledging explanation only re-presents
        self.assertEqual(self.store.current()[0],0)
        self.assertEqual(self.c.state()['mode'],'awaiting')
        self.c.message(self.request('마지막 항목은 제외해'))
        s=self.terminal();self.assertEqual(len(s['current']['proposal']['targets']),len(p['targets'])-1)
        request=self.request('응')
        self.c.message(request)
        self.c.control({'action':'pause'})
        self.assertEqual(self.store.current()[0],1)
        receipt=self.store.history()[0]['conversation_approval']
        self.assertEqual(receipt['message_id'],request['id']);self.assertEqual(receipt['message'],'응')
        self.assertEqual(len(receipt['targets']),len(p['targets'])-1)
        self.c.message(request);self.assertEqual(self.store.current()[0],1)
        self.assertEqual(self.store.current()[1]['texts'][int(p['targets'][-1]['ref'].split('/')[-1])],p['targets'][-1]['before'])
        self.store.undo(1);self.assertEqual(self.store.current()[1],self.original)

    def test_old_tab_generation_and_multiple_offers_cannot_approve(self):
        self.start();old=self.request('응')
        self.c.message(self.request('마지막 항목 제외'))
        self.terminal();self.c.message(old);self.assertEqual(self.store.current()[0],0)
        self.c.message(self.request('[two]'))
        s=self.terminal();self.assertEqual(len(s['offers']),2);self.assertEqual(s['mode'],'discussing')
        self.c.message(self.request('응'));self.assertEqual(self.store.current()[0],0)
        self.assertEqual(self.c.s['mode'],'discussing')
        self.assertEqual(len(self.c.s['offers']),2)
        self.c.control({'action':'present','offer':s['offers'][1]['id']})
        self.assertEqual(self.c.s['mode'],'awaiting')

    def test_keep_defer_next_previous_and_reopen(self):
        s=self.start();gid=s['group']
        self.c.message(self.request('그대로 둬'));self.terminal()
        self.assertEqual(self.store.current()[0],1)
        self.assertEqual(self.store.current()[1],self.original)
        self.c.message(self.request('보류해'));self.terminal()
        self.assertEqual(self.store.current()[0],2)
        self.c.control({'action':'previous'});s=self.terminal();self.assertNotEqual(s['mode'],'error',s['note'])
        self.c.control({'action':'pause'});self.close();self.open()
        self.assertEqual(self.c.state()['mode'],'paused')
        self.assertEqual(self.c.state()['settings'],{'model':'mock-a','effort':'medium'})
        self.c.control({'action':'resume'});self.assertEqual(self.c.s['mode'],'discussing')
        self.assertEqual(self.store.current()[0],2)
        self.assertTrue(any(t['state']=='kept' for g in self.batch.groups() if g['id']==gid for t in g['targets']))

    def test_frozen_selected_cell_stale_proposal_and_injection(self):
        self.start();req=self.request('[propose] [attack]')
        req.update(inspect=True,presentation=None,context=self.c._context('#/tables/0',0))
        self.c.message(req);req['context']['cell']=1
        s=self.terminal();self.assertEqual(s['current']['proposal']['request']['cell'],0)
        self.assertEqual(self.store.current()[0],0)
        self.c.message(self.request('이 셀의 수정안을 설명해'))
        self.terminal()
        previous=self.c.chat.state()['runs'][-1]['target']['review']['previous_offer']['proposal']
        self.assertEqual(previous['cell'],0)
        self.assertEqual(previous['after'],{'text':'Synthetic correction'})
        self.assertNotIn('table_cells',json.dumps(previous))
        self.c.message(self.request('응')) # re-present after explanation, no approval
        # An independent judgment invalidates the pending same-item correction.
        p=self.store.propose(dict(asset_id=self.store.manifest['asset_id'],revision=0,ref='#/tables/0',op='keep',reason='test',cell=0))
        self.store.decide(p['id'],'approve')
        with self.assertRaises(Exception):self.c.message(self.request('응'))
        self.assertEqual(self.store.current()[0],1)

    def test_cancel_disconnect_and_resume_do_not_replay(self):
        self.start();self.c.message(self.request('[slow]'))
        wait(lambda:self.c.chat.state()['runs'][-1]['output'])
        self.c.control({'action':'pause'});self.assertEqual(self.c.s['mode'],'paused')
        with self.assertRaises(ValueError):self.c.message(self.request('응'))
        count=len(self.c.chat.state()['runs'])
        self.c.control({'action':'resume'});self.assertEqual(len(self.c.chat.state()['runs']),count)
        self.c.message(self.request('[crash]'));s=self.terminal();self.assertEqual(s['mode'],'error')
        self.c.control({'action':'resume'});self.assertEqual(self.store.current()[0],0)

    def test_export_failure_and_crash_gap_receipt_reconcile(self):
        self.start();req=self.request('응');atomic=core.atomic
        def fail(path,content):
            if Path(path).name=='document.json':raise PermissionError('synthetic export failure')
            return atomic(path,content)
        with patch('candoc.core.atomic',side_effect=fail):self.c.message(req)
        self.assertEqual(self.c.s['mode'],'paused');self.assertEqual(self.store.current()[0],1)
        self.assertEqual(self.c.state()['export']['state'],'pending')
        self.close();self.open();self.c.message(req)
        self.assertEqual(self.store.current()[0],1)
        self.assertTrue(next(m for m in self.c.state()['messages'] if m['id']==req['id'])['result']['committed'])
        self.store.export();self.store.undo(1);self.assertEqual(self.store.current()[1],self.original)

    def test_database_failure_rolls_back_no_false_success(self):
        self.start()
        with self.store.db:self.store.db.execute("CREATE TRIGGER fail_conversation BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT,'synthetic DB failure'); END")
        with self.assertRaises(Exception):self.c.message(self.request('응'))
        self.assertEqual(self.store.current()[0],0);self.assertEqual(self.c.s['mode'],'error')
        self.assertEqual(self.store.current()[1],self.original)

    def test_commit_then_journal_failure_reconciles_from_document_history(self):
        self.start();req=self.request('응')
        original_save=self.c._save
        def fail_after_commit():
            if self.store.current()[0]>0:raise OSError('synthetic journal persistence failure')
            original_save()
        with patch.object(self.c,'_save',side_effect=fail_after_commit):
            with self.assertRaises(OSError):self.c.message(req)
        # Stop auto-next for this crash simulation; document receipt already committed.
        self.c.closed.set();self.close();self.open()
        s=self.c.message(req)
        self.assertEqual(s['revision'],1);self.assertFalse(s['can_approve'])
        self.assertTrue(next(m for m in s['messages'] if m['id']==req['id'])['result']['committed'])
        self.store.undo(1);self.assertEqual(self.store.current()[1],self.original)

    def test_concurrent_duplicate_approvals_commit_once(self):
        from concurrent.futures import ThreadPoolExecutor
        self.start();req=self.request('응')
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies=list(pool.map(self.c.message,[req,copy.deepcopy(req)]))
        self.c.control({'action':'pause'})
        self.assertEqual(self.store.current()[0],1)
        self.assertEqual(len([e for e in self.store.history() if e.get('conversation_approval',{}).get('message_id')==req['id']]),1)

    def test_selection_snapshot_exception_and_inspect_separates_previous_offer(self):
        first=self.start()['current']
        request=self.request('[slow] 선택한 이 항목의 이유를 설명해')
        request['selection']=self.c._context(first['refs'][-1],group=first['context']['group_id'])
        self.c.message(request);request['selection']['ref']=first['refs'][0]
        run=wait(lambda:self.c.chat.state()['runs'][-1] if self.c.chat.state()['runs'][-1]['status']=='running' else None)
        self.assertEqual(run['target']['review']['user_selection_at_send']['ref'],first['refs'][-1])
        self.c.control({'action':'pause'});self.c.control({'action':'resume'})
        r=self.request('선택한 셀이 어떤 뜻이야?');r.update(inspect=True,context=self.c._context('#/tables/0',0))
        self.c.message(r);s=self.terminal();self.assertIsNone(s['current'])
        self.c.message(self.request('응'));self.assertEqual(self.store.current()[0],0)

    def test_model_configuration_changes_only_next_turn(self):
        self.start();self.c.message(self.request('[slow]'))
        with self.assertRaises(ValueError):self.c.configure({'model':'mock-b','effort':'high'})
        self.c.control({'action':'pause'});self.c.configure({'model':'mock-b','effort':'high'})
        self.c.control({'action':'resume'});self.c.message(self.request('추가 설명해'))
        self.terminal();runs=self.c.chat.state()['runs']
        self.assertEqual(runs[-1]['target']['execution'],{'model':'mock-b','effort':'high'})
        self.assertEqual(runs[-2]['target']['execution'],{'model':'mock-a','effort':'medium'})


if __name__=='__main__':unittest.main()
