"""Synthetic JSONL app-server. Never calls a model, reads credentials, or approves."""
import argparse
import copy
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from candoc.codex_rpc import SECURITY_CONFIG

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--scenario', default='normal')
parser.add_argument('--overrides', default='{}')
args = parser.parse_args()
args.state.mkdir(parents=True, exist_ok=True)
lock = threading.Lock()
waiting = {}
cancel = threading.Event()
thread_id, turn_id = None, None


def emit(value):
    with lock:
        print(json.dumps(value, ensure_ascii=False), flush=True)


def log(value):
    with lock:
        with (args.state/'wire.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps(value, ensure_ascii=False)+'\n')


def result(request, value):
    emit({'id': request['id'], 'result': value})


def event(method, **params):
    emit({'method': method, 'params': {'threadId': thread_id, **params}})


def invoke(name, arguments, suffix='', foreign=False, namespace=None):
    call = 'tool-'+suffix
    waiter = queue.Queue()
    waiting[call] = waiter
    emit({'id': call, 'method': 'item/tool/call', 'params': {
        'threadId': 'foreign' if foreign else thread_id, 'turnId': turn_id,
        'callId': suffix, 'tool': name, 'arguments': arguments, 'namespace': namespace}})
    reply = waiter.get(timeout=10)
    waiting.pop(call, None)
    log({'tool_reply': reply})
    return reply


def turn(request):
    global turn_id
    turn_id = 'turn-'+uuid.uuid4().hex
    own_turn = turn_id
    cancel.clear()
    event('turn/started', turn={'id': turn_id, 'status': 'inProgress'})
    if args.scenario == 'timeout_start':
        time.sleep(20)
        return
    result(request, {'turn': {'id': turn_id, 'status': 'inProgress', 'items': [], 'error': None}})
    text = request['params']['input'][0]['text']
    context = json.loads(text.split('\n', 1)[1].split('\n\nUser message:\n')[0])
    user = text.split('\n\nUser message:\n')[1]
    event('item/agentMessage/delta', turnId=turn_id, itemId='answer', delta='검토 중입니다. ')
    if '[child]' in user:
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (args.state/'child.pid').write_text(str(child.pid))
    if '[crash]' in user:
        time.sleep(.1)
        os._exit(19)
    if '[bad-json]' in user:
        with lock:
            print('not json', flush=True)
        time.sleep(120)
        return
    if '[slow]' in user or '[child]' in user:
        if cancel.wait(30):
            return
    if '[error]' in user:
        event('turn/completed', turn={'id': turn_id, 'status': 'failed', 'error': {'message': 'Synthetic model failure'}})
        return
    if '[propose]' in user:
        invoke('candoc_read_selection', {}, 'read')
        proposal = {'op': 'cell' if context['cell'] is not None else 'text', 'value': 'Synthetic correction', 'reason': 'Synthetic test proposal; user must approve'}
        invoke('candoc_propose_correction', proposal, 'proposal')
        if '[duplicate-tool]' in user:
            invoke('candoc_propose_correction', proposal, 'proposal')
    if context.get('review') and ('수정안이 있으면 준비' in user or '제외' in user or '[two]' in user):
        frozen = context['review']
        invoke('candoc_review_read', {}, 'review-read')
        excluded = [frozen['refs'][-1]] if '제외' in user else []
        action = 'apply' if frozen['group']['kind']=='margin' else 'defer'
        invoke('candoc_review_prepare', {'action': action, 'exclude_refs': excluded}, 'review-prepare')
        if '[two]' in user:
            invoke('candoc_review_prepare', {'action': action, 'exclude_refs': [frozen['refs'][-1]]}, 'review-prepare-2')
    if '[attack]' in user:
        for name, payload in [('exec_command', {'cmd':'write forbidden'}), ('apply_patch', {}),
                              ('candoc_propose_correction', {'op':'text','value':'Wrong target','reason':'attack','ref':'#/texts/1'}),
                              ('candoc_read_selection', {'ref':'#/texts/1'})]:
            invoke(name, payload, name)
        invoke('candoc_propose_correction', {'op':'text','value':'Wrong turn','reason':'attack'}, 'foreign', True)
        emit({'id': 'approval', 'method': 'item/commandExecution/requestApproval', 'params': {'threadId':thread_id,'turnId':turn_id,'itemId':'attack'}})
    time.sleep(.12)
    if not cancel.is_set():
        event('item/agentMessage/delta', turnId=own_turn, itemId='answer', delta='선택 대상을 확인했습니다. 실제 모델 응답이 아닌 모의 응답입니다.')
        event('turn/completed', turn={'id': own_turn, 'status': 'completed', 'error': None})


for line in sys.stdin:
    message = json.loads(line)
    log(message)
    if 'method' not in message:
        if message.get('id') in waiting:
            waiting[message['id']].put(message)
        continue
    method = message['method']
    if method == 'initialized':
        continue
    if method == 'initialize':
        result(message, {'userAgent':'mock-codex/0.160.0','platformOs':sys.platform})
    elif method == 'account/read':
        result(message, {'account': None if args.scenario=='no_login' else {'type':'chatgpt'}, 'requiresOpenaiAuth':True})
    elif method == 'config/read':
        config = {}
        for key,value in SECURITY_CONFIG.items():
            cur = config
            parts=key.split('.')
            for part in parts[:-1]:cur=cur.setdefault(part,{})
            cur[parts[-1]]=copy.deepcopy(value)
        config['mcp_servers']={'unrelated':{'enabled':not bool(json.loads(args.overrides))}}
        if args.scenario=='bad_config':config['features']['shell_tool']=True
        if args.scenario=='mcp_remains':config['mcp_servers']['unrelated']['enabled']=True
        result(message, {'config':config,'origins':{},'layers':[{'name':{'type':'sessionFlags'},'config':config}]})
    elif method in ('thread/start','thread/resume'):
        if method=='thread/resume' and args.scenario=='missing_rollout':
            emit({'id':message['id'],'error':{'code':-32600,'message':'no rollout found for thread id '+message['params']['threadId']}})
            continue
        file=args.state/'thread.json'
        if method=='thread/start':
            thread_id='thread-'+uuid.uuid4().hex
            thread={'id':thread_id,'sessionId':'session-'+uuid.uuid4().hex}
            (args.state/'threads').mkdir(exist_ok=True)
            (args.state/'threads'/(thread_id+'.json')).write_text(json.dumps(thread),encoding='utf-8')
            file.write_text(json.dumps(thread),encoding='utf-8')
        else:
            saved=args.state/'threads'/(message['params']['threadId']+'.json')
            thread=json.loads((saved if saved.exists() else file).read_text('utf-8'))
        thread_id=thread['id']
        result(message, {'thread':thread,'sandbox':{'type':'dangerFullAccess' if args.scenario=='bad_sandbox' else 'readOnly'},
            'approvalPolicy':'never','approvalsReviewer':'user','modelProvider':'openai','model':'mock-no-model'})
    elif method=='mcpServerStatus/list':result(message,{'data':[{'name':'unrelated','runtimeStatus':'disabled','tools':{},'resources':[],'resourceTemplates':[]}],'nextCursor':None})
    elif method=='model/list':
        if args.scenario=='models_fail':
            emit({'id':message['id'],'error':{'code':-32603,'message':'Synthetic model catalog unavailable'}})
        else:
            second=bool(message['params'].get('cursor'))
            result(message, {'data':[{'id':'mock-b' if second else 'mock-a','model':'mock-b' if second else 'mock-a',
                'displayName':'Synthetic B' if second else 'Synthetic A','hidden':False,'isDefault':not second,
                'defaultReasoningEffort':'high' if second else 'low',
                'supportedReasoningEfforts':[{'reasoningEffort':x,'description':'Synthetic effort'} for x in (['high'] if second else ['low','medium'])]}],
                'nextCursor':None if second else 'page-two'})
    elif method=='turn/start':threading.Thread(target=turn,args=(message,),daemon=True).start()
    elif method=='turn/interrupt':
        result(message,{})
        if args.scenario!='hang_interrupt':
            cancel.set()
            event('turn/completed',turn={'id':turn_id,'status':'interrupted','error':None})
    else:
        emit({'id':message['id'],'error':{'code':-32601,'message':'Unsupported mock method'}})
