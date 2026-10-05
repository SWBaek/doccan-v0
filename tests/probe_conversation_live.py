"""Explicitly authorized real-model probe: at most three turns, zero approvals.

Must never be run by unittest discovery. Uses only a freshly initialized test Asset.
"""
import argparse
import hashlib
import json
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from candoc.core import ROOT, Store, initialize
from candoc.batch import BatchReview
from candoc.conversation import Conversation
from candoc.codex_rpc import StdioRPC


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--authorized-three-turns',action='store_true',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    report={'actual_model':True,'max_turns':3,'approvals_sent':0,'new_auth':False,'turns':[]}
    def save():
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
    with tempfile.TemporaryDirectory(prefix='candoc-live-review-') as tmp:
        root=Path(tmp);initialize(ROOT/'IEEE-1547-2018-document-assets.zip',root/'asset')
        store=Store(root/'asset');batch=BatchReview(store);store.batch=batch
        c=Conversation(store,batch,{'state_dir':root/'chat','project_dir':ROOT,'codex_executable':'codex','model':None},StdioRPC)
        try:
            catalog=c.models()['models'];report['catalog']=catalog;save()
            selected=next((m for m in catalog if m['isDefault']),catalog[0])
            effort=selected['defaultReasoningEffort']
            if effort not in [e['reasoningEffort'] for e in selected['supportedReasoningEfforts']]:
                raise ValueError('Official default effort not supported')
            report['selected']={'model':selected['model'],'effort':effort};save()
            c.configure(report['selected']);c.control({'action':'start'})
            for i in range(3):
                deadline=time.monotonic()+480
                while c.s['mode'] in ('thinking','diagnosing','advancing') and time.monotonic()<deadline:time.sleep(.5)
                state=c.state()
                run=c.chat.state()['runs'][-1] if state['chat']['runs'] else None
                report['turns'].append({'mode':state['mode'],'note':state['note'],'run':run,
                    'offers':[{'id':o['id'],'kind':o['kind'],'refs':o['refs'],'proposal_id':o['proposal_id']} for o in state['offers']]})
                save()
                print('Turn',i+1,'status',state['mode'],flush=True)
                if state['mode']=='error' or not run or run['status']!='completed':break
                if i==2:break
                context={k:state['context'][k] for k in ('asset_id','revision','ref','cell','group_id') if k in state['context']}
                if i==0:message='왜 그렇게 생각해? 최초 변환 텍스트만으로 원본이 맞다고 단정할 수 있는지도 설명해 줘.'
                else:
                    target=run['target']['review']['group']['targets'][-1]
                    message=f"{target['page']}쪽의 {target['ref']} 항목은 제외하고 수정안을 다시 보여줘. 아직 승인하지는 않을게."
                c.message({'id':str(uuid.uuid4()),'message':message,'presentation':state['current']['id'] if state['current'] else None,
                    'generation':state['generation'],'context':context,'inspect':False})
            report.update(revision=store.current()[0],source_validation=store.check_original(),
                status='PASS' if len(report['turns'])==3 and all(t['run'] and t['run']['status']=='completed' for t in report['turns']) else 'INCOMPLETE')
            assert store.current()[0]==0
        except Exception as exc:
            report.update(status='FAIL',error=str(exc));raise
        finally:
            c.control({'action':'pause'})
            if c.chat.rpc:
                try:c.chat.rpc.call('thread/archive',{'threadId':c.chat.state()['thread_id']})
                except Exception:pass
            c.close();batch.close();store.close();save()
    print(json.dumps({k:v for k,v in report.items() if k not in ('turns','catalog')},ensure_ascii=False))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');main()
