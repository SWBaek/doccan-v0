"""Batch diagnostics/approval regressions. Only temporary/test Assets are written."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from candoc import core
from candoc.core import ROOT, Store, initialize, resolve, validate, ProposalConflict
from candoc.batch import BatchReview
from candoc.diagnostics import detect
from candoc.chat import Chat


def fixture():
    """Small synthetic margin corpus, not a claim about actual detection accuracy."""
    doc={'pages':{str(i):{'size':{'width':600,'height':800}} for i in range(1,13)},'texts':[],'tables':[],'pictures':[]}
    def add(text,page,y,label='text',x=40,origin='BOTTOMLEFT'):
        i=len(doc['texts']);box={'l':x,'r':x+200,'t':800-y if origin=='BOTTOMLEFT' else y,'b':800-y-15 if origin=='BOTTOMLEFT' else y+15,'coord_origin':origin}
        t={'self_ref':f'#/texts/{i}','text':text,'orig':text,'label':label,'content_layer':'furniture' if label.startswith('page_') else 'body','parent':{'$ref':'#/body'},'children':[],'prov':[{'page_no':page,'bbox':box,'charspan':[0,len(text)]}]}
        if label=='section_header':t['level']=1
        doc['texts'].append(t);return t
    for i in range(1,13):add('Interior body',i,220)
    return doc,add


class DetectionRules(unittest.TestCase):
    def test_margin_digit_parity_chapter_and_origins(self):
        doc,add=fixture()
        for i in range(1,13):
            add(f'Page {i}',i,750,origin='TOPLEFT' if i%2 else 'BOTTOMLEFT')
            add('Odd running name' if i%2 else 'Even running name',i,35)
            add('Chapter A running text' if i<=6 else 'Chapter B running text',i,58,'page_header' if i in (1,2,7,8) else 'section_header')
        groups=detect(doc);m=[g for g in groups if g['kind']=='margin']
        self.assertEqual(len(m),5)
        footer=next(g for g in m if g['targets'][0]['suggested']=='page_footer')
        self.assertEqual(len(footer['targets']),12)
        self.assertEqual(footer['evidence']['top_ratio_range'],[.9375,.9375])
        odd=next(g for g in m if g['evidence']['pattern']=='Odd running name')
        self.assertEqual((odd['evidence']['odd'],odd['evidence']['even']),(6,0))
        self.assertFalse(any('accuracy' in g for g in groups))

    def test_repeated_headings_notes_table_columns_and_associations_are_not_furniture(self):
        doc,add=fixture()
        for i in range(1,13):
            add('Actual chapter heading',i,40,'section_header')
            add('NOTE Same caution',i,750)
            add(f'{i} Unlabelled footnote explanation',i,735)
            foot=add('Repeated referenced footnote',i,730)
            col=add('Repeated table column',i,65)
            doc['tables'].append({'self_ref':f'#/tables/{i-1}','prov':[{'page_no':i,'bbox':{'l':20,'r':300,'t':62,'b':300,'coord_origin':'TOPLEFT'}}], 'footnotes':[{'$ref':foot['self_ref']}],'data':{'table_cells':[]}})
        self.assertEqual(detect(doc),[])

    def test_similarity_anchors_and_review_only_structures(self):
        doc,add=fixture()
        for i in range(1,8):add('Long recurring document name in the margin'+('s' if i==7 else ''),i,40,'page_header' if i<3 else 'section_header')
        heading=add('2.3.4 Actual subsection',4,260,'section_header')
        table={'self_ref':'#/tables/0','prov':[{'page_no':5,'bbox':{'l':20,'r':300,'t':150,'b':300,'coord_origin':'TOPLEFT'}}],'data':{'table_cells':[dict(start_row_offset_idx=0,end_row_offset_idx=1,start_col_offset_idx=0,end_col_offset_idx=1)]*2}}
        doc['tables'].append(table)
        groups=detect(doc)
        self.assertEqual(len(groups),3)
        self.assertEqual(len(next(g for g in groups if g['kind']=='margin')['targets']),5)
        self.assertEqual(next(g for g in groups if g['kind']=='heading_level')['targets'][0]['ref'],heading['self_ref'])
        self.assertIsNone(next(g for g in groups if g['kind']=='table_overlap')['targets'][0]['suggested'])


class BatchWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='candoc-batch-')
        cls.data=Path(cls.temp.name)/'asset'
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip',cls.data)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def setUp(self):
        self.store=Store(self.data);self.batch=BatchReview(self.store);self.store.batch=self.batch
        self.diagnose()
        self.g=next(g for g in self.batch.state()['groups'] if g['kind']=='margin' and g['evidence']['pattern']=='IEEE Std 1547-2018')
        self.refs=[t['ref'] for t in self.g['targets'][:3]]

    def tearDown(self):
        self.batch.close()
        while True:
            events=self.store.history();undone={e['undoes'] for e in events if e['kind']=='undo'}
            if not any(e['kind']=='apply' and e['seq'] not in undone for e in events):break
            self.store.undo(self.store.current()[0])
        self.store.close()

    def diagnose(self):
        self.batch.start();self.batch.worker.join(15)
        self.assertEqual(self.batch.job['status'],'completed')

    def preview(self,refs=None,action='apply'):
        return self.batch.preview(dict(group=self.g['id'],refs=refs or self.refs,action=action,request_id=uuid.uuid4().hex))

    def one(self,ref,op='keep',value=None):
        req=dict(asset_id=self.store.manifest['asset_id'],revision=self.store.current()[0],ref=ref,op=op,reason='Isolated batch regression')
        if value is not None:req['value']=value
        p=self.store.propose(req);return self.store.decide(p['id'],'approve')

    def test_batch_exclusion_exact_fields_reopen_and_one_undo(self):
        rev,before,reviews=self.store.current();p=self.preview(self.refs[:2]);self.assertEqual(self.store.current()[0],rev)
        event=self.batch.approve(p['id']);self.assertEqual(event['seq'],rev+1)
        after=self.store.current()[1]
        for ref in self.refs[:2]:
            a=resolve(after,ref);b=resolve(before,ref)
            self.assertEqual(a['label'],'page_header');self.assertEqual(a['content_layer'],'furniture');self.assertNotIn('level',a)
            self.assertEqual({k:v for k,v in a.items() if k not in ('label','content_layer','level')},{k:v for k,v in b.items() if k not in ('label','content_layer','level')})
            self.assertFalse(self.store.current()[2][ref]['individually_reviewed'])
        self.assertEqual(resolve(after,self.refs[2]),resolve(before,self.refs[2]))
        validate(after,self.store.source,images=True);self.store.check_original()
        self.batch.close();self.store.close();self.store=Store(self.data);self.batch=BatchReview(self.store)
        self.assertEqual(self.store.current()[1],after)
        self.store.undo(rev+1);self.assertEqual(self.store.current()[1],before);self.assertEqual(self.store.current()[2],reviews)
        self.assertEqual(self.batch.view(p['id'])['status'],'undone')

    def test_latest_conflict_all_or_none_and_aba(self):
        p=self.preview();before=copy.deepcopy(resolve(self.store.current()[1],self.refs[1]));self.one(self.refs[0])
        with self.assertRaises(ProposalConflict) as error:self.batch.approve(p['id'])
        self.assertEqual(len(error.exception.proposal['conflicts']),1)
        self.assertEqual(resolve(self.store.current()[1],self.refs[1]),before)
        self.store.undo(self.store.current()[0])
        with self.assertRaises(ProposalConflict):self.batch.approve(p['id'])
        with self.assertRaises(ProposalConflict):self.preview()
        self.diagnose();p2=self.preview();self.batch.approve(p2['id'])

    def test_unrelated_change_and_duplicate_click(self):
        p=self.preview();self.one('#/texts/0')
        def attempt():
            try:return self.batch.approve(p['id'])['committed']
            except ProposalConflict:return False
        with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(lambda _:attempt(),range(2)))
        self.assertEqual(sorted(result),[False,True])
        self.assertEqual(sum(e.get('proposal')==p['id'] for e in self.store.history()),1)
        # A legacy pending proposal also sees all refs touched by a batch.
        self.store.undo(self.store.current()[0]);self.diagnose()
        req=dict(asset_id=self.store.manifest['asset_id'],revision=self.store.current()[0],ref=self.refs[1],op='keep',reason='test')
        legacy=self.store.propose(req);self.batch.approve(self.preview()['id'])
        with self.assertRaises(ProposalConflict):self.store.decide(legacy['id'],'approve')

    def test_rediagnose_idempotency_and_keep_defer_preserved_then_recheck(self):
        ids=[g['id'] for g in self.batch.state()['groups']]
        p=self.preview(self.refs[:1],'keep');self.assertEqual(self.batch.preview(p['request'])['id'],p['id']);self.batch.approve(p['id'])
        # This target changed review version; explicitly re-diagnose before next decision.
        self.diagnose();q=self.preview(self.refs[1:2],'defer');self.batch.approve(q['id']);self.diagnose()
        result=self.batch.state();g=next(g for g in result['groups'] if g['id']==self.g['id'])
        self.assertEqual([g['id'] for g in result['groups']],ids)
        states={t['ref']:t['state'] for t in g['targets']}
        self.assertEqual(states[self.refs[0]],'kept');self.assertEqual(states[self.refs[1]],'deferred')
        self.one(self.refs[0],'text','Changed test-only header')
        self.diagnose();g=next(g for g in self.batch.state()['groups'] if g['id']==self.g['id'])
        t=next(t for t in g['targets'] if t['ref']==self.refs[0]);self.assertEqual(t['state'],'recheck')
        self.assertIn('바뀌었습니다',t['recheck_reason'])
        # A changed target which disappeared from detection can still be reviewed.
        recovered=self.preview(self.refs[:1],'keep');self.batch.approve(recovered['id'])

    def test_database_failure_rolls_back_and_export_failure_recovers(self):
        p=self.preview();before=self.store.current()
        self.store.db.execute("CREATE TEMP TRIGGER fail_batch BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'injected database failure'); END")
        with self.assertRaises(Exception):self.batch.approve(p['id'])
        self.assertEqual(self.store.current(),before);self.assertEqual(self.batch.view(p['id'])['status'],'pending')
        self.store.db.execute('DROP TRIGGER fail_batch')
        real=core.atomic
        def fail(path,content):
            if Path(path).name=='document.json':raise PermissionError('injected export failure')
            return real(path,content)
        with patch('candoc.core.atomic',side_effect=fail):
            event=self.batch.approve(p['id']);self.assertTrue(event['committed']);self.assertEqual(event['export']['state'],'pending')
            self.batch.close();self.store.close();self.store=Store(self.data);self.batch=BatchReview(self.store)
            self.assertEqual(self.store.export_status()['state'],'pending');self.assertEqual(self.batch.view(p['id'])['status'],'applied')
        rev=self.store.current()[0];events=len(self.store.history());self.assertEqual(self.store.export()['state'],'synced')
        self.assertEqual(self.store.current()[0],rev);self.assertEqual(len(self.store.history()),events)

    def test_cancel_fail_retry_preserves_completed_groups(self):
        previous=[g['id'] for g in self.batch.state()['groups']];entered=threading.Event();release=threading.Event()
        def slow(doc,progress,cancelled):
            entered.set();release.wait(3)
            if cancelled():raise InterruptedError('test cancellation')
            return detect(doc)
        with patch('candoc.batch.detect',side_effect=slow):
            self.batch.start();entered.wait(2);self.batch.cancel();release.set();self.batch.worker.join(5)
        self.assertEqual(self.batch.job['status'],'cancelled');self.assertEqual([g['id'] for g in self.batch.state()['groups']],previous)
        with patch('candoc.batch.detect',side_effect=ValueError('test failure')):
            self.batch.start();self.batch.worker.join(5)
        self.assertEqual(self.batch.job['status'],'failed');self.assertEqual([g['id'] for g in self.batch.state()['groups']],previous)
        self.diagnose()

    def test_diagnosis_snapshot_change_and_interrupted_restart(self):
        entered=threading.Event();release=threading.Event();real_detect=detect
        def paused(doc,progress,cancelled):
            entered.set();release.wait(3)
            return real_detect(doc,progress,cancelled)
        with patch('candoc.batch.detect',side_effect=paused):
            self.batch.start();entered.wait(2);self.one(self.refs[0]);release.set();self.batch.worker.join(5)
        with self.assertRaises(ProposalConflict):self.preview()
        self.assertNotEqual(self.batch.state()['job']['revision'],self.batch.state()['job']['current_revision'])
        self.batch.job['status']='running';self.batch._save_job();self.batch.close();self.store.close()
        self.store=Store(self.data);self.batch=BatchReview(self.store)
        self.assertEqual(self.batch.job['status'],'failed')
        self.assertTrue(self.batch.state()['groups'])
        self.diagnose()

    def test_review_only_and_chat_context_scope(self):
        g=next(g for g in self.batch.state()['groups'] if g['kind']=='table_overlap')
        req=dict(group=g['id'],refs=[g['targets'][0]['ref']],action='apply',request_id=uuid.uuid4().hex)
        with self.assertRaises(ValueError):self.batch.preview(req)
        chat=Chat(self.store,None)
        try:
            ctx=dict(asset_id=self.store.manifest['asset_id'],revision=self.store.current()[0],ref=self.refs[0],cell=None,group_id=self.g['id'])
            self.assertEqual(chat.snapshot(ctx)['diagnostic_group']['id'],self.g['id'])
            ctx['ref']='#/texts/0'
            with self.assertRaises(ValueError):chat.snapshot(ctx)
        finally:chat.close()


if __name__=='__main__':unittest.main()
