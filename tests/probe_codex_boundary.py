"""Explicit offline-boundary probe: real Codex + local synthetic Responses server.

No OpenAI endpoint, login or model is used. The child has an empty temporary
Codex home; its provider points exclusively to a loopback synthetic fixture.
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from candoc.chat import TOOLS
from candoc.codex_rpc import StdioRPC, SECURITY_CONFIG, executable_path, config_args, child_environment


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--codex',default='codex')
    parser.add_argument('--model',default='gpt-6.1-sol',help='Offline catalog selection only; no actual model is invoked')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    executable=executable_path(args.codex)
    with tempfile.TemporaryDirectory(prefix='candoc-offline-boundary-') as temp:
        root=Path(temp); home=root/'codex-home'; home.mkdir()
        sentinel=root/'forbidden-write.txt'; mcp_sentinel=root/'forbidden-mcp.txt'
        # Deliberately unsafe test MCP. The discovery phase must not launch it,
        # and the conversation phase must explicitly disable it.
        (home/'config.toml').write_text('[mcp_servers.probe_mcp]\ncommand = '+json.dumps(sys.executable)+'\nargs = '+json.dumps(['-c',f'from pathlib import Path; Path({str(mcp_sentinel)!r}).write_text("unsafe")'])+'\n','utf-8')
        requests=[]; notifications=[]; calls=[]; rpc=None

        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_GET(self):
                body=b'{"data":[]}'
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(payload)
                index=len(requests)
                if index==1:
                    item={'type':'function_call','id':'fc_shell','call_id':'call_shell','name':'exec_command',
                          'arguments':json.dumps({'cmd':f'echo forbidden > "{sentinel}"'})}
                elif index==2:
                    item={'type':'custom_tool_call','id':'fc_patch','call_id':'call_patch','name':'apply_patch',
                          'input':f'*** Begin Patch\n*** Add File: {sentinel}\n+forbidden\n*** End Patch'}
                elif index==3:
                    item={'type':'function_call','id':'fc_read','call_id':'call_read','name':'candoc_read_selection','arguments':'{}'}
                elif index==4 and args.model=='gpt-6.1-sol':
                    item={'type':'custom_tool_call','id':'fc_code','call_id':'call_code','name':'exec','namespace':'functions',
                          'input':'text({require:typeof require,process:typeof process,fetch:typeof fetch,tools:ALL_TOOLS.map(x=>x.name)}); try { await tools.exec_command({cmd:"forbidden"}); } catch (e) { text(String(e)); } text(await tools.candoc_read_selection({}));'}
                else:
                    item={'type':'message','role':'assistant','id':'msg_end','status':'completed',
                          'content':[{'type':'output_text','text':'Synthetic boundary probe complete.'}]}
                events=[{'type':'response.created','response':{'id':f'resp_{index}'}},
                        {'type':'response.output_item.added','output_index':0,'item':item},
                        {'type':'response.output_item.done','output_index':0,'item':item},
                        {'type':'response.completed','response':{'id':f'resp_{index}','output':[item],
                         'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}}]
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
                for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
                self.wfile.flush()

        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        config={**SECURITY_CONFIG,'model_provider':'candoc_synthetic','model':args.model,
            'features.enable_request_compression':False,
            'model_providers.candoc_synthetic.name':'CanDoc local synthetic fixture',
            'model_providers.candoc_synthetic.base_url':f'http://127.0.0.1:{server.server_port}/v1',
            'model_providers.candoc_synthetic.wire_api':'responses',
            'model_providers.candoc_synthetic.requires_openai_auth':False,
            'model_providers.candoc_synthetic.supports_websockets':False}
        env=child_environment();env['CODEX_HOME']=str(home)
        def on_request(message):
            calls.append(message)
            rpc.send({'id':message['id'],'result':{'contentItems':[{'type':'inputText','text':'Synthetic selected cell only'}],'success':True}})
        def spawn(extra):
            return StdioRPC(executable,root,notifications.append,on_request,lambda:None,timeout=20,env=env,
                command=[executable,'app-server','--listen','stdio://',*config_args({**config,**extra})])
        def initialize():
            rpc.call('initialize',{'clientInfo':{'name':'candoc_boundary_test','version':'0.1.0'},'capabilities':{'experimentalApi':True}})
            rpc.send({'method':'initialized','params':{}})
        try:
            rpc=spawn({});initialize()
            discovered=rpc.call('config/read',{'cwd':str(root),'includeLayers':False})['config']
            assert 'probe_mcp' in discovered['mcp_servers']
            assert not mcp_sentinel.exists(),'Discovery started an unapproved MCP'
            rpc.close()
            rpc=spawn({'mcp_servers.probe_mcp.enabled':False});initialize()
            created=rpc.call('thread/start',{'cwd':str(root),'environments':[], 'dynamicTools':TOOLS,
                'sandbox':'read-only','approvalPolicy':'never','approvalsReviewer':'user','modelProvider':'candoc_synthetic'})
            thread_id=created['thread']['id']
            mcp=rpc.call('mcpServerStatus/list',{'threadId':thread_id,'limit':100,'detail':'toolsAndAuthOnly'})
            assert all(s['runtimeStatus']=='disabled' and not s['tools'] for s in mcp['data']),mcp
            rpc.call('turn/start',{'threadId':thread_id,'input':[{'type':'text','text':'Synthetic boundary test; no real document.'}],
                'environments':[],'sandboxPolicy':{'type':'readOnly'},'approvalPolicy':'never','approvalsReviewer':'user'})
            deadline=time.monotonic()+30
            while time.monotonic()<deadline and not any(m.get('method')=='turn/completed' for m in notifications):time.sleep(.05)
            completed=[m for m in notifications if m.get('method')=='turn/completed']
            assert completed and completed[-1]['params']['turn']['status']=='completed',completed
            assert not sentinel.exists(),'A forbidden file write succeeded'
            assert not mcp_sentinel.exists(),'Disabled MCP was launched'
            def names(tools):
                out=[]
                for tool in tools:
                    if tool.get('type')=='namespace':out.extend(names(tool.get('tools',[])))
                    else:out.append(tool.get('name',tool.get('type')))
                return out
            tools=requests[0].get('tools',[])
            for entry in requests[0].get('input',[]):
                if entry.get('type')=='additional_tools':tools.extend(entry.get('tools',[]))
            if not tools:
                raise AssertionError({'request_keys':list(requests[0]),'input_types':[(entry.get('type'),list(entry)) for entry in requests[0].get('input',[])]})
            exposed=names(tools)
            args.output.with_name('synthetic-model-request.json').write_text(json.dumps(requests[0],ensure_ascii=False,indent=2),'utf-8')
            assert 'exec_command' not in exposed and 'apply_patch' not in exposed,exposed
            assert not any(name.startswith('mcp__') for name in exposed),exposed
            expected_calls=['candoc_read_selection']*(2 if args.model=='gpt-6.1-sol' else 1)
            assert [m['params']['tool'] for m in calls]==expected_calls,calls
            # Persisted session resume, still entirely offline and with no new inference.
            count=len(requests);rpc.close();rpc=spawn({'mcp_servers.probe_mcp.enabled':False});initialize()
            resumed=rpc.call('thread/resume',{'threadId':thread_id,'cwd':str(root),'sandbox':'read-only','approvalPolicy':'never','approvalsReviewer':'user','modelProvider':'candoc_synthetic'})
            assert resumed['thread']['id']==thread_id
            assert len(requests)==count
            outputs=[item for req in requests for item in req.get('input',[]) if item.get('type') in ('function_call_output','custom_tool_call_output')]
            report={'result':'PASS','codex_version':'0.160.0','catalog_model':args.model,'actual_app_server':True,'real_model_called':False,
                'synthetic_http_requests':len(requests),'exposed_tools':exposed,'forbidden_write_created':sentinel.exists(),
                'disabled_mcp_started':mcp_sentinel.exists(),'dynamic_calls':[m['params']['tool'] for m in calls],
                'session_resume':True,'tool_rejections':[x.get('output') for x in outputs if x.get('call_id') in ('call_shell','call_patch')],
                'code_mode_probe':[x.get('output') for x in outputs if x.get('call_id')=='call_code']}
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
            print(json.dumps(report,ensure_ascii=False))
        finally:
            if rpc:rpc.close()
            server.shutdown();server.server_close()


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    main()
