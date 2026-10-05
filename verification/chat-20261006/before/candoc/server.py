from __future__ import annotations

import argparse
import json
import mimetypes
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .core import ROOT, Store, ProposalConflict, dump, local_path, validate, items
from .render import render_page


def make_server(data, port=52741):
    store = Store(data)
    token = secrets.token_urlsafe(32)
    cache = {}

    class Handler(BaseHTTPRequestHandler):
        def send(self, value, status=200, mime='application/json; charset=utf-8'):
            body = value if isinstance(value, bytes) else (dump(value) if mime.startswith('application/json') else value).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def allowed_host(self):
            return self.headers.get('Host') in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}

        def do_GET(self):
            if not self.allowed_host():
                return self.send({'error': 'Invalid Host'}, 403)
            try:
                with store.lock:
                    self.get()
            except (ValueError, KeyError, IndexError, TypeError) as e:
                self.send({'error': str(e)}, 400)
            except Exception as e:
                self.log_error('%s', e)
                self.send({'error': str(e)}, 500)

        def get(self):
            u = urlsplit(self.path)
            q = parse_qs(u.query)
            path = unquote(u.path)
            if path == '/favicon.ico':
                return self.send(b'', status=204, mime='image/x-icon')
            revision, doc, reviews = store.current()
            if path == '/api/bootstrap':
                return self.send({'token': token, 'asset': store.manifest, 'revision': revision, 'export': store.export_status(), 'pages': sorted(map(int, doc['pages'])), 'reviews': reviews, 'counts': {'total': len(items(doc)), 'review_decisions': len(reviews)}, 'unlocated': [v['self_ref'] for v in items(doc) if not v.get('prov')]})
            if path == '/api/export-status':
                return self.send(store.export_status())
            if path == '/api/page':
                page = int(q['page'][0])
                if (revision, page) not in cache:
                    if len(cache) > 8:
                        cache.clear()
                    cache[revision,page] = render_page(doc,page)
                p = doc['pages'][str(page)]
                return self.send({'revision': revision, 'page': page, 'size': p['size'], 'image': '/asset/'+p['image']['uri'], 'items': cache[revision,page]})
            if path == '/api/item':
                info = store.get_item(q['ref'][0])
                if 'cell' in q:
                    cell = int(q['cell'][0])
                    if cell < 0 or cell >= len(info['item']['data']['table_cells']):
                        raise ValueError('Invalid cell')
                    info['cell'] = cell
                    info['locations'] = store.locations(doc,info['item'],cell)
                return self.send(info)
            if path == '/api/proposals':
                return self.send(store.proposals())
            if path == '/api/history':
                return self.send(store.history())
            if path == '/api/suspects':
                return self.send(store.suspects())
            if path == '/api/search':
                query = q.get('q', [''])[0].lower()
                return self.send([{'ref': v['self_ref'], 'page': v['prov'][0]['page_no'] if v.get('prov') else None, 'text': v.get('text', v['label'])[:220]} for v in items(doc) if query in v.get('text','').lower() or query in v['self_ref'].lower() or any(query in c['text'].lower() for c in v.get('data',{}).get('table_cells',[]))][:150])
            if path == '/api/validate':
                return self.send({**validate(doc, store.source, images=True), **store.check_original(), 'revision': revision, 'export': store.export_status()})
            if path == '/api/document':
                return self.send(doc)
            if path.startswith('/asset/'):
                p = local_path(store.source, path[len('/asset/'):])
                if p.suffix.lower() not in {'.png','.jpg','.jpeg'}:
                    raise ValueError('Only raster assets are served')
                return self.send(p.read_bytes(), mime=mimetypes.guess_type(p.name)[0])
            static = {'/': 'index.html', '/app.js':'app.js', '/style.css':'style.css'}
            if path in static:
                p = ROOT/'web'/static[path]
                return self.send(p.read_bytes(), mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[p.suffix])
            return self.send({'error':'Not found'},404)

        def do_POST(self):
            if not self.allowed_host() or self.headers.get('X-Candoc-Token') != token:
                return self.send({'error':'Invalid local session'},403)
            origin = self.headers.get('Origin')
            if origin and origin not in {f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}:
                return self.send({'error':'Foreign origin'},403)
            try:
                length = int(self.headers.get('Content-Length','0'))
                if not 0 < length < 200000:
                    raise ValueError('Invalid request size')
                req = json.loads(self.rfile.read(length))
                if self.path == '/api/propose':
                    return self.send(store.propose(req))
                if self.path == '/api/repropose':
                    return self.send(store.repropose(req['id'],req['revision']))
                if self.path == '/api/export':
                    return self.send(store.export())
                if self.path == '/api/decision':
                    return self.send(store.decide(req['id'],req['action']))
                if self.path == '/api/undo':
                    return self.send(store.undo(req['revision']))
                self.send({'error':'Unknown action'},404)
            except ProposalConflict as e:
                self.send({'error': str(e), 'code': 'proposal_conflict', 'proposal': e.proposal,
                           'export': store.export_status()}, 409)
            except (ValueError,KeyError,IndexError,TypeError) as e:
                self.send({'error':str(e)},400)
            except Exception as e:
                self.log_error('%s',e)
                self.send({'error':str(e)},500)

    try:
        server = ThreadingHTTPServer(('127.0.0.1',port),Handler)
    except OSError:
        store.close()
        raise
    server.store = store
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data',type=Path,default=ROOT/'data')
    parser.add_argument('--port',type=int,default=52741)
    args = parser.parse_args()
    server = make_server(args.data,args.port)
    print(f'CanDoc review: http://127.0.0.1:{server.server_port}',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.store.close()


if __name__ == '__main__':
    main()
