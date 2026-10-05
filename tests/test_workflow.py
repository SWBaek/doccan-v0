import copy
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from lxml import html
from docling_core.types.doc import BoundingBox

from candoc.core import ROOT, Store, initialize, items, rect, resolve, sha, validate
from candoc.render import render_page, sanitize


class AssetWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='candoc-test-')
        cls.data = Path(cls.temp.name)/'data'
        cls.zip_hash = sha(ROOT/'IEEE-1547-2018-document-assets.zip')
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip',cls.data)
        cls.store = Store(cls.data)
        cls.original = copy.deepcopy(cls.store.original)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()
        cls.temp.cleanup()

    def request(self,op,ref,value=None,**extra):
        return {'asset_id':self.store.manifest['asset_id'],'revision':self.store.current()[0],'ref':ref,'op':op,'value':value,'reason':'Isolated automated test; not a document correction',**extra}

    def test_01_asset_and_origins(self):
        report=validate(self.original,self.store.source,images=True)
        self.assertEqual((report['pages'],report['texts'],report['tables'],report['pictures']),(138,2937,71,29))
        self.assertEqual(report['images_checked'],167)
        self.assertEqual(report['references_checked'],6307)
        self.assertEqual(report['element_bbox_origins'],{'BOTTOMLEFT':3055})
        self.assertEqual(report['cell_bbox_origins'],{'TOPLEFT':2991})
        self.assertEqual(report['warnings'],['Overlapping table cells (preserved): #/tables/56'])
        self.assertFalse(self.store.manifest['original_pdf_present'])
        text=self.store.get_item('#/texts/0')['locations'][0]
        self.assertEqual(text['rect']['y'],57)
        self.assertEqual(text['rect']['height'],15)
        table=self.store.get_item('#/tables/0')['locations'][0]
        self.assertAlmostEqual(table['rect']['y'],344.1055603027344)
        cell=self.store.locations(self.original,self.original['tables'][0],0)[0]
        self.assertAlmostEqual(cell['rect']['y'],345.6417)
        picture=self.store.get_item('#/pictures/0')['locations'][0]
        self.assertAlmostEqual(picture['rect']['y'],55.96450424194336)
        with self.assertRaises(ValueError):
            rect({'l':0,'r':1,'t':0,'b':1,'coord_origin':'UNKNOWN'},{'height':792})
        for item in items(self.original):
            for p in item.get('prov',[]):
                size=self.original['pages'][str(p['page_no'])]['size']
                expected=BoundingBox.model_validate(p['bbox']).to_top_left_origin(size['height'])
                actual=rect(p['bbox'],size)
                self.assertEqual(actual,{'x':expected.l,'y':expected.t,'width':expected.r-expected.l,'height':expected.b-expected.t})
            if item['self_ref'].startswith('#/tables/') and len(item['prov'])==1:
                for cell in item['data']['table_cells']:
                    if cell.get('bbox'):
                        expected=BoundingBox.model_validate(cell['bbox']).to_top_left_origin(size['height'])
                        actual=rect(cell['bbox'],size)
                        self.assertEqual(actual['y'],expected.t)

    def test_02_three_corrections_reopen_and_undo(self):
        for op,ref,value,extra in [('text','#/texts/0','TEST approved text',{}),('type','#/texts/0','section_header',{'level':2}),('cell','#/tables/0','TEST approved cell',{'cell':0})]:
            revision,doc,_=self.store.current()
            p=self.store.propose(self.request(op,ref,value,**extra))
            self.assertEqual(self.store.current()[0],revision)
            self.assertEqual(self.store.current()[1],doc)
            self.store.decide(p['id'],'approve')
            exported=json.loads((self.data/'work/document.json').read_text('utf-8'))
            validate(exported,self.store.source,images=True)
            self.store.close()
            self.__class__.store=Store(self.data)
            self.assertEqual(self.store.current()[1],exported)
            changed=resolve(exported,ref)
            if op=='text':
                self.assertEqual(changed['text'],value)
                self.assertEqual(changed['orig'],self.original['texts'][0]['orig'])
                self.assertEqual(changed['prov'][0]['charspan'],[0,len(value)])
                self.assertEqual(changed['prov'][0]['bbox'],self.original['texts'][0]['prov'][0]['bbox'])
            if op=='type':
                self.assertEqual(changed['label'],'section_header')
                self.assertEqual(changed['level'],2)
            if op=='cell':
                self.assertEqual(changed['data']['table_cells'][0]['text'],value)
                self.assertEqual(changed['data']['table_cells'][0]['bbox'],self.original['tables'][0]['data']['table_cells'][0]['bbox'])
            state=self.store.current()[2][p['scope']]['state']
            self.assertEqual(state,'corrected_partial')
        for _ in range(3):
            self.store.undo(self.store.current()[0])
        self.assertEqual(self.store.current()[1],self.original)
        self.assertEqual(self.store.current()[2],{})
        self.assertEqual(json.loads((self.data/'work/document.json').read_text('utf-8')),self.original)
        self.assertEqual(self.store.check_original()['unchanged_source_files'],168)
        self.assertEqual(sha(ROOT/'IEEE-1547-2018-document-assets.zip'),self.zip_hash)

    def test_03_stale_replay_unsupported_and_wrong_asset(self):
        p=self.store.propose(self.request('text','#/texts/0','proposal one'))
        stale=self.store.propose(self.request('text','#/texts/0','proposal two'))
        self.store.decide(p['id'],'approve')
        with self.assertRaisesRegex(ValueError,'Stale'):
            self.store.decide(stale['id'],'approve')
        with self.assertRaisesRegex(ValueError,'already decided'):
            self.store.decide(p['id'],'approve')
        with self.assertRaisesRegex(ValueError,'Revision changed'):
            self.store.undo(-1)
        self.store.undo(self.store.current()[0])
        self.store.decide(stale['id'],'reject')
        for req in [self.request('merge','#/texts/0'),self.request('type','#/texts/0','table'),self.request('type','#/texts/0','section_header'),self.request('cell','#/tables/0','x',cell=-1),self.request('text','#/texts/3','ambiguous spans'),{**self.request('text','#/texts/0','x'),'asset_id':'wrong'},self.request('text','#/texts/0','x',parent={'$ref':'#/body'})]:
            with self.assertRaises(ValueError):
                self.store.propose(req)
        self.assertEqual(self.store.current()[1],self.original)

    def test_04_review_scope_undo_and_export_recovery(self):
        p=self.store.propose(self.request('keep','#/tables/0'))
        self.store.decide(p['id'],'approve')
        p=self.store.propose(self.request('cell','#/tables/0','scoped test',cell=0))
        self.store.decide(p['id'],'approve')
        self.assertNotIn('#/tables/0',self.store.current()[2])
        self.assertEqual(self.store.current()[2]['#/tables/0/cells/0']['state'],'corrected_partial')
        self.store.undo(self.store.current()[0])
        self.assertEqual(self.store.current()[2]['#/tables/0']['state'],'kept')
        self.store.undo(self.store.current()[0])
        p=self.store.propose(self.request('defer','#/tables/56'))
        self.store.decide(p['id'],'approve')
        self.assertEqual(self.store.current()[2]['#/tables/56']['state'],'deferred')
        (self.data/'work/document.json').write_text('{}','utf-8')
        self.store.close()
        self.__class__.store=Store(self.data)
        self.assertEqual(json.loads((self.data/'work/document.json').read_text('utf-8')),self.original)
        self.store.undo(self.store.current()[0])
        self.assertEqual(self.store.current()[2],{})
        with self.assertRaisesRegex(ValueError,'already open'):
            Store(self.data)

    def test_05_references_and_immutability_guards(self):
        invalid=copy.deepcopy(self.original)
        invalid['texts'][0]['self_ref']='#/texts/99999'
        with self.assertRaises((ValueError,IndexError)):
            validate(invalid)
        target=self.store.source/'document.json'
        original_bytes=target.read_bytes()
        try:
            target.write_bytes(original_bytes+b' ')
            p=self.store.propose(self.request('text','#/texts/0','blocked'))
            with self.assertRaisesRegex(ValueError,'Original files changed'):
                self.store.decide(p['id'],'approve')
        finally:
            target.write_bytes(original_bytes)
        self.assertEqual(self.store.current()[1],self.original)

    def test_06_all_pages_official_html_and_selection(self):
        seen=set()
        picture_sources=[]
        for page in range(1,139):
            rendered=render_page(self.original,page)
            expected={i['self_ref'] for i in items(self.original) if any(p['page_no']==page for p in i.get('prov',[]))}
            self.assertEqual({i['ref'] for i in rendered},expected)
            for item in rendered:
                seen.add(item['ref'])
                root=html.fromstring(item['html'])
                self.assertFalse(root.xpath('.//script'))
                if item['ref'].startswith('#/pictures/'):
                    picture_sources.extend(root.xpath('.//img/@src'))
                if item['ref'].startswith('#/tables/') and item['ref']!='#/tables/56':
                    cells=resolve(self.original,item['ref'])['data']['table_cells']
                    for el in root.xpath('.//*[@data-cell]'):
                        self.assertEqual(el.text_content().strip(),cells[int(el.get('data-cell'))]['text'].strip())
        self.assertEqual(len(seen),3037)
        self.assertEqual(len(picture_sources),29)
        self.assertTrue(all(x.startswith('/asset/artifacts/') for x in picture_sources))
        self.assertFalse(sanitize('<script>alert(1)</script><img src="https://example.com/x" onerror="alert(1)">').xpath('.//script | .//*[@onerror] | .//img[@src]'))


if __name__=='__main__':
    unittest.main(verbosity=2)
