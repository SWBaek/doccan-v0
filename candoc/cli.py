"""Agent bridge. Intentionally has no approval or undo command."""
import argparse
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError

from .core import ROOT, dump, initialize


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:52741')
    sub = parser.add_subparsers(dest='command',required=True)
    init = sub.add_parser('init')
    init.add_argument('--zip',type=Path,default=ROOT/'IEEE-1547-2018-document-assets.zip')
    init.add_argument('--data',type=Path,default=ROOT/'data')
    for name in ['status','suspects','proposals','history','validate','reexport','document','diagnostics','diagnose','conversation']:
        sub.add_parser(name)
    repropose = sub.add_parser('repropose', help='Create a new unapproved proposal after inspecting latest data')
    repropose.add_argument('id')
    repropose.add_argument('--revision', required=True, type=int)
    get = sub.add_parser('get')
    get.add_argument('ref')
    get.add_argument('--cell',type=int)
    search = sub.add_parser('search')
    search.add_argument('query')
    propose = sub.add_parser('propose')
    propose.add_argument('file',type=Path,help='UTF-8 JSON with asset_id, revision, ref, op, value, reason')
    args = parser.parse_args()
    if args.command == 'init':
        print(dump(initialize(args.zip,args.data)))
        return
    def api(path, payload=None):
        headers = {}
        body = None
        if payload is not None or path == '/api/conversation/state':
            session = api('/api/bootstrap')
            headers = {'Content-Type':'application/json','X-Candoc-Token':session['token']}
        if payload is not None:
            body = dump(payload).encode('utf-8')
        with urlopen(Request(args.url+path, data=body, headers=headers),timeout=90) as r:
            return json.load(r)
    try:
        if args.command == 'get':
            q = {'ref':args.ref}
            if args.cell is not None:
                q['cell'] = args.cell
            result = api('/api/item?'+urlencode(q))
        elif args.command == 'search':
            result = api('/api/search?'+urlencode({'q':args.query}))
        elif args.command == 'propose':
            result = api('/api/propose',json.loads(args.file.read_text('utf-8-sig')))
        elif args.command == 'repropose':
            result = api('/api/repropose', {'id': args.id, 'revision': args.revision})
        elif args.command == 'diagnose':
            result = api('/api/diagnose', {})
        elif args.command == 'conversation':
            result = api('/api/conversation/state')
        elif args.command == 'reexport':
            result = api('/api/export', {})
        else:
            result = api('/api/'+('bootstrap' if args.command == 'status' else args.command))
            if args.command == 'status':
                result.pop('token',None)
        print(dump(result))
        if args.command == 'reexport' and result['state'] != 'synced':
            parser.exit(2, 'Committed data is safe in the database; JSON export remains pending.\n')
    except HTTPError as e:
        parser.exit(1,e.read().decode('utf-8')+'\n')


if __name__ == '__main__':
    main()
