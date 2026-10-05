"""Isolated process/API tests. No real model calls or user credentials."""
import copy
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
import jsonschema
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from candoc.chat import Chat, TOOLS, load_settings
from candoc.codex_rpc import CodexError, StdioRPC, SECURITY_CONFIG, child_environment
from candoc.core import ROOT, Store, initialize
from candoc.server import make_server


def wait_for(predicate, timeout=8):
    end = time.monotonic()+timeout
    while time.monotonic()<end:
        value = predicate()
        if value:
            return value
        time.sleep(.03)
    raise AssertionError('Timed out waiting for test state')


def alive(pid):
    if os.name=='nt':
        kernel=ctypes.WinDLL('kernel32')
        kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
        kernel.OpenProcess.restype=ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
        kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.OpenProcess(0x100000,False,pid)
        if not handle:return False
        try:return kernel.WaitForSingleObject(handle,0)==258
        finally:kernel.CloseHandle(handle)
    try:
        os.kill(pid,0)
        return True
    except ProcessLookupError:return False


class ChatWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='candoc-chat-tests-')
        cls.root=Path(cls.temp.name)
        cls.template=cls.root/'template'
        initialize(ROOT/'IEEE-1547-2018-document-assets.zip',cls.template)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.dir=self.root/self._testMethodName
        self.data=self.dir/'asset'
        shutil.copytree(self.template,self.data)
        self.store=Store(self.data)
        self.settings={'codex_executable':'unused-native-codex','project_dir':ROOT,
                       'state_dir':self.dir/'conversations','model':None}
        self.scenario='normal'
        self.timeout=3
        self.processes=[]
        self.chat=Chat(self.store,self.settings,rpc_factory=self.factory)

    def factory(self, executable,cwd,on_event,on_request,on_exit,*,overrides=None):
        rpc=StdioRPC(executable,cwd,on_event,on_request,on_exit,timeout=self.timeout,
            command=[sys.executable,str(ROOT/'tests/fake_codex.py'),'--state',str(self.dir/'fake'),
                     '--scenario',self.scenario,'--overrides',json.dumps(overrides or {})])
        self.processes.append(rpc.proc)
        return rpc

    def tearDown(self):
        self.chat.close()
        self.store.close()
        for proc in self.processes:
            self.assertIsNotNone(proc.poll(),'Owned mock app-server was not reaped')

    def context(self,ref='#/texts/0',cell=None):
        return {'asset_id':self.store.manifest['asset_id'],'revision':self.store.current()[0],'ref':ref,'cell':cell}

    def request(self,message='inspect',**kw):
        return {'id':str(uuid.uuid4()),'message':message,'context':self.context(**kw)}

    def terminal(self):
        return wait_for(lambda: next((r for r in self.chat.state()['runs'] if r['status'] in ('completed','failed','interrupted')),None))

    def wire(self):
        file=self.dir/'fake/wire.jsonl'
        return [json.loads(line) for line in file.read_text('utf-8').splitlines()] if file.exists() else []

    def test_streaming_and_frozen_cell_selection(self):
        self.chat.connect()
        request=self.request('[slow]',ref='#/tables/0',cell=0)
        self.chat.submit(request)
        wait_for(lambda: self.chat.state()['runs'][0]['output'])
        request['context']['cell']=1
        run=self.chat.state()['runs'][0]
        self.assertEqual(run['target']['cell'],0)
        self.assertEqual(run['target']['text'],self.store.original['tables'][0]['data']['table_cells'][0]['text'])
        self.assertEqual(run['target']['locations'][0]['bbox']['coord_origin'],'TOPLEFT')
        self.assertNotIn('table_cells',json.dumps(run['target']))
        self.assertNotIn('image',json.dumps(run['target']))
        self.assertEqual(run['status'],'running')
        self.chat.interrupt()
        self.assertEqual(self.terminal()['status'],'interrupted')

    def test_resume_after_process_and_app_restart(self):
        self.chat.connect()
        request=self.request()
        self.chat.submit(request)
        self.assertEqual(self.terminal()['status'],'completed')
        before=self.chat.state()
        self.chat.disconnect()
        self.chat.close()
        self.chat=Chat(self.store,self.settings,rpc_factory=self.factory)
        self.chat.connect()
        after=self.chat.state()
        self.assertEqual(after['thread_id'],before['thread_id'])
        self.assertEqual(after['session_id'],before['session_id'])
        self.assertEqual(after['runs'],before['runs'])
        self.assertEqual(sum(m.get('method')=='thread/resume' for m in self.wire()),1)
        self.chat.submit(request)
        self.assertEqual(sum(m.get('method')=='turn/start' for m in self.wire()),1)

    def test_duplicate_send_and_changed_payload_are_not_replayed(self):
        self.chat.connect()
        request=self.request('[slow]')
        self.chat.submit(request)
        self.chat.submit(copy.deepcopy(request))
        with self.assertRaisesRegex(ValueError,'같은 메시지 ID'):
            self.chat.submit({**request,'message':'different'})
        with self.assertRaisesRegex(ValueError,'실행 중'):
            self.chat.submit(self.request())
        self.chat.interrupt()
        self.assertEqual(len(self.chat.state()['runs']),1)
        self.assertLessEqual(sum(m.get('method')=='turn/start' for m in self.wire()),1)

    def test_proposal_duplicate_tool_and_separate_user_approval(self):
        before=(self.data/'work/document.json').read_bytes()
        self.chat.connect()
        self.chat.submit(self.request('[propose] [duplicate-tool]',ref='#/tables/0',cell=0))
        self.assertEqual(self.terminal()['status'],'completed')
        proposals=self.store.proposals()
        self.assertEqual(len(proposals),1)
        self.assertEqual(proposals[0]['status'],'pending')
        self.assertEqual(proposals[0]['scope'],'#/tables/0/cells/0')
        self.assertEqual(self.store.current()[0],0)
        self.assertEqual((self.data/'work/document.json').read_bytes(),before)
        # Authorized test-only equivalent of the separate human approval endpoint.
        self.store.decide(proposals[0]['id'],'approve')
        self.assertEqual(self.store.current()[1]['tables'][0]['data']['table_cells'][0]['text'],'Synthetic correction')
        self.store.undo(1)
        self.assertEqual(self.store.current()[1],self.store.original)
        self.store.check_original()

    def test_tool_attacks_and_foreign_turn_have_no_authority(self):
        self.chat.connect()
        self.chat.submit(self.request('[attack]'))
        self.terminal()
        replies=[m['tool_reply'] for m in self.wire() if 'tool_reply' in m]
        self.assertEqual(len(replies),5)
        self.assertTrue(all(m['result']['success'] is False for m in replies))
        self.assertTrue(any(m.get('id')=='approval' and 'error' in m for m in self.wire()))
        self.assertEqual(self.store.proposals(),[])
        self.assertEqual(self.store.current()[0],0)
        self.assertEqual(self.store.current()[1],self.store.original)

    def test_stale_context_during_turn_cannot_create_proposal(self):
        self.chat.connect()
        self.chat.submit(self.request('[slow]'))
        wait_for(lambda:self.chat.state()['runs'][0]['turn_id'])
        run=self.chat.state()['runs'][0]
        basis=self.context()
        basis.pop('cell')
        proposal=self.store.propose({**basis,'op':'text','value':'Latest human correction','reason':'test'})
        self.store.decide(proposal['id'],'approve')
        result=self.chat._tool({'threadId':self.chat.state()['thread_id'],'turnId':run['turn_id'],
            'tool':'candoc_propose_correction','callId':'stale','arguments':{'op':'text','value':'Old intent','reason':'test'}})
        self.assertFalse(result['success'])
        self.assertEqual(len(self.store.proposals()),1)
        self.assertEqual(self.store.current()[1]['texts'][0]['text'],'Latest human correction')
        self.chat.interrupt()
        self.store.undo(1)
        self.assertEqual(self.store.current()[1],self.store.original)

    def test_login_and_security_mismatches_fail_closed(self):
        for scenario in ('no_login','bad_config','mcp_remains','bad_sandbox'):
            with self.subTest(scenario=scenario):
                self.scenario=scenario
                with self.assertRaises(CodexError):self.chat.connect()
                self.assertEqual(self.chat.state()['connection'],'error')
                self.assertIsNone(self.chat.rpc)
        self.assertFalse(any(m.get('method')=='turn/start' for m in self.wire()))

    def test_process_crash_and_malformed_stream_are_errors(self):
        for marker in ('[crash]','[bad-json]'):
            with self.subTest(marker=marker):
                self.chat.connect()
                request=self.request(marker)
                self.chat.submit(request)
                wait_for(lambda:self.chat.state()['connection']=='error')
                run=next(r for r in self.chat.state()['runs'] if r['id']==request['id'])
                self.assertEqual(run['status'],'interrupted')
                self.chat.connect()
                self.chat.submit(request)
        self.assertEqual(sum(m.get('method')=='turn/start' for m in self.wire()),2)

    def test_model_error_is_not_completion(self):
        self.chat.connect()
        self.chat.submit(self.request('[error]'))
        run=self.terminal()
        self.assertEqual(run['status'],'failed')
        self.assertIn('Synthetic model failure',run['error'])

    def test_interrupt_missing_completion_kills_owned_child_tree(self):
        self.scenario='hang_interrupt'
        self.chat.connect()
        self.chat.submit(self.request('[child]'))
        child_file=self.dir/'fake/child.pid'
        wait_for(child_file.exists)
        child_pid=int(child_file.read_text())
        self.assertTrue(alive(child_pid))
        self.chat.interrupt()
        wait_for(lambda:self.chat.state()['connection']=='error')
        wait_for(lambda:not alive(child_pid))
        self.assertEqual(self.terminal()['status'],'interrupted')

    def test_disconnect_and_server_close_stop_owned_processes(self):
        self.chat.connect()
        self.chat.submit(self.request('[slow]'))
        wait_for(lambda:self.chat.state()['runs'][0]['output'])
        proc=self.chat.rpc.proc
        self.chat.close()
        self.assertIsNotNone(proc.poll())
        self.chat=Chat(self.store,self.settings,rpc_factory=self.factory)
        self.assertEqual(self.chat.state()['runs'][0]['status'],'interrupted')
        self.assertEqual(self.chat.state()['connection'],'disconnected')

    def test_start_timeout_is_uncertain_and_never_resent(self):
        self.scenario='timeout_start'
        self.timeout=.5
        self.chat.connect()
        request=self.request()
        self.chat.submit(request)
        wait_for(lambda:self.chat.state()['connection']=='error')
        self.assertEqual(self.chat.state()['runs'][0]['status'],'failed')
        self.scenario='normal'
        self.chat.connect()
        self.chat.submit(request)
        self.assertEqual(sum(m.get('method')=='turn/start' for m in self.wire()),1)

    def test_target_validation_minimization_and_no_selection(self):
        context=self.context(ref=None)
        target=self.chat.snapshot(context)
        self.assertNotIn('text',target)
        self.assertEqual(target['page_count'],138)
        bad={**context,'revision':999}
        with self.assertRaisesRegex(ValueError,'revision'):self.chat.snapshot(bad)
        for cell in (-1,True,99999):
            with self.assertRaises(ValueError):self.chat.snapshot(self.context('#/tables/0',cell))
        self.chat.connect()
        self.chat.submit(self.request('[slow]',ref=None))
        wait_for(lambda:self.chat.state()['runs'][0]['turn_id'])
        run=self.chat.state()['runs'][0]
        result=self.chat._tool({'threadId':self.chat.state()['thread_id'],'turnId':run['turn_id'],
            'tool':'candoc_propose_correction','callId':'none','arguments':{'op':'text','value':'x','reason':'test'}})
        self.assertFalse(result['success'])
        self.assertEqual(self.store.proposals(),[])

    def test_portable_settings_and_environment_never_accept_credentials(self):
        path=self.dir/'settings.json'
        path.write_text(json.dumps({'project_dir':'.','state_dir':'chat-state','codex_executable':'codex','model':None}),'utf-8')
        value=load_settings(path)
        self.assertEqual(value['project_dir'],self.dir)
        self.assertEqual(value['state_dir'],self.dir/'chat-state')
        path.write_text('{"api_key":"not-a-real-key"}','utf-8')
        with self.assertRaises(ValueError):load_settings(path)
        with patch.dict(os.environ,{'PASEO_SESSION_ID':'fake','OPENAI_API_KEY':'fake','CODEX_API_KEY':'fake','CODEX_THREAD_ID':'fake'}):
            env=child_environment()
        self.assertFalse(any(key in env for key in ('PASEO_SESSION_ID','OPENAI_API_KEY','CODEX_API_KEY','CODEX_THREAD_ID')))

    def test_wire_requests_match_generated_official_schema(self):
        self.chat.connect()
        self.chat.submit(self.request('[slow]'))
        wait_for(lambda:self.chat.state()['runs'][0]['turn_id'])
        self.chat.interrupt()
        self.terminal()
        self.chat.disconnect()
        self.chat.connect()
        schemas=json.loads((ROOT/'tests/fixtures/codex-0.160.0.json').read_text('utf-8'))['params']
        checked=set()
        for request in self.wire():
            method=request.get('method')
            if method in schemas:
                jsonschema.Draft7Validator(schemas[method]).validate(request['params'])
                checked.add(method)
        self.assertEqual(checked,set(schemas))
        for request in self.wire():
            if request.get('method') in ('thread/start','turn/start'):
                self.assertEqual(request['params']['environments'],[])
            if request.get('method')=='thread/start':
                self.assertEqual(request['params']['dynamicTools'],TOOLS)

    def test_child_surviving_crashed_parent_is_reaped(self):
        self.chat.connect()
        self.chat.submit(self.request('[child] [crash]'))
        child_file=self.dir/'fake/child.pid'
        wait_for(child_file.exists)
        child_pid=int(child_file.read_text())
        wait_for(lambda:self.chat.state()['connection']=='error')
        wait_for(lambda:not alive(child_pid))

    def test_terminal_agent_item_without_deltas_is_preserved(self):
        self.chat.connect()
        self.chat.submit(self.request('[slow]'))
        wait_for(lambda:self.chat.state()['runs'][0]['turn_id'])
        run=self.chat.state()['runs'][0]
        self.chat._notification({'method':'item/completed','params':{'threadId':self.chat.state()['thread_id'],'turnId':run['turn_id'],
            'item':{'type':'agentMessage','id':'final-only','text':'Final message without deltas'}}})
        self.assertTrue(self.chat.state()['runs'][0]['output'].endswith('Final message without deltas'))
        self.chat.interrupt()

    def test_only_blank_missing_thread_can_be_recreated(self):
        first=self.chat.connect()['thread_id']
        self.chat.disconnect()
        self.scenario='missing_rollout'
        second=self.chat.connect()['thread_id']
        self.assertNotEqual(first,second)
        self.chat.submit(self.request())
        self.terminal()
        self.chat.disconnect()
        with self.assertRaisesRegex(CodexError,'no rollout found'):
            self.chat.connect()
        self.assertEqual(self.chat.state()['thread_id'],second)
        self.assertEqual(len(self.chat.state()['runs']),1)
        self.assertEqual(sum(m.get('method')=='thread/start' for m in self.wire()),2)

    def test_missing_and_unverified_executable_fail_before_model(self):
        with self.assertRaisesRegex(CodexError,'찾지 못했습니다'):
            StdioRPC(str(self.dir/'does-not-exist'),self.dir,lambda m:None,lambda m:None,lambda:None)
        with self.assertRaisesRegex(CodexError,'0.160.0'):
            StdioRPC(sys.executable,self.dir,lambda m:None,lambda m:None,lambda:None)

    def test_http_sse_auth_and_proposal_approval_are_separate(self):
        self.chat.close()
        self.store.close()
        server=make_server(self.data,0,self.settings,rpc_factory=self.factory)
        self.store=server.store
        self.chat=server.chat
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        token=json.load(urlopen(base+'/api/bootstrap'))['token']
        def api(path,body=None):
            headers={'X-Candoc-Token':token,'Content-Type':'application/json'}
            with urlopen(Request(base+path,headers=headers,data=None if body is None else json.dumps(body).encode()),timeout=10) as response:
                return json.load(response)
        try:
            with self.assertRaises(HTTPError):urlopen(base+'/api/chat/state')
            api('/api/chat/connect',{})
            api('/api/chat/message',self.request('[propose]'))
            self.terminal()
            with urlopen(Request(base+'/api/chat/events?after=0',headers={'X-Candoc-Token':token}),timeout=5) as stream:
                first=stream.readline().decode()
                self.assertTrue(first.startswith('data: '))
            proposals=api('/api/proposals')
            self.assertEqual(proposals[0]['status'],'pending')
            self.assertEqual(self.store.current()[0],0)
            api('/api/decision',{'id':proposals[0]['id'],'action':'approve'})
            self.assertEqual(self.store.current()[0],1)
            api('/api/undo',{'revision':1})
            self.assertEqual(self.store.current()[1],self.store.original)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__=='__main__':unittest.main()
