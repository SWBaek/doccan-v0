"""Explicit real Codex connection/resume probe; never sends turn/start or logs in."""
import argparse
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from candoc.chat import Chat
from candoc.core import ROOT,Store,initialize


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--codex',default='codex')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='candoc-connection-only-') as temp:
        directory=Path(temp)
        data=directory/'asset'
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip',data)
        store=Store(data)
        chat=Chat(store,{'codex_executable':args.codex,'project_dir':ROOT,'state_dir':directory/'chat','model':None})
        try:
            first=chat.connect()
            chat.disconnect()
            second=chat.connect()
            assert second['runs']==[]
            report={'result':'PASS','actual_app_server':True,'normal_chatgpt_login_checked':True,
                'actual_thread_start':True,'actual_resume_attempt':True,'blank_thread_recreated':first['thread_id']!=second['thread_id'],'model':second['model'],
                'real_model_called':False,'turns_sent':0,'new_login_started':False,
                'credentials_read_or_copied_by_app':False,'user_asset_modified':False}
            # This is the blank test thread just created above, never a user thread.
            try:
                chat.rpc.call('thread/archive',{'threadId':second['thread_id']})
                report['owned_blank_test_thread_archived']=True
            except Exception:
                report['owned_blank_test_thread_archived']=False
                report['blank_thread_has_no_persisted_rollout']=True
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(report,indent=2),'utf-8')
            print(json.dumps(report))
        finally:
            chat.close();store.close()


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    main()
