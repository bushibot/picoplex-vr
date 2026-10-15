"""Run: tests/make_mock.sh && python3 tests/e2e_mock.py   (needs: pip install playwright && playwright install chromium; ffmpeg; Pillow)

End-to-end test of PicoPlex VR in headless Chromium against mocked plex.tv + PMS."""
import json, re, sys, os, threading, functools, http.server, time
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MOCK = os.path.join(HERE, 'mock')
OUT = os.path.join(HERE, 'shots')
os.makedirs(OUT, exist_ok=True)
SRV = 'https://192-168-1-8.abc123.plex.direct:32400'

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(H, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()

log = []
pin_polls = {'n': 0}

def movie(i, off=0, vc=0):
    return {'ratingKey': f'm{i}', 'type': 'movie', 'title': f'Movie Number {i}', 'year': 1990 + i % 30,
            'thumb': f'/library/metadata/m{i}/thumb/1', 'duration': 6_000_000, 'viewOffset': off, 'viewCount': vc,
            'summary': 'A long synopsis ' * 30, 'contentRating': 'PG-13'}

MOVIES = [movie(i, off=(20_000 if i == 2 else 0), vc=(1 if i % 5 == 0 else 0)) for i in range(400)]
SHOWS = [{'ratingKey': f's{i}', 'type': 'show', 'title': f'Show {i}', 'year': 2010 + i, 'thumb': f'/t/s{i}',
          'leafCount': 20, 'viewedLeafCount': (20 if i == 1 else 3 * (i % 4)), 'childCount': 2} for i in range(20)]

def episode(show, season, e):
    return {'ratingKey': f'e{show}_{season}_{e}', 'type': 'episode', 'title': f'Episode Title {e}', 'index': e,
            'parentIndex': season, 'parentRatingKey': f'se{show}_{season}', 'grandparentRatingKey': f's{show}',
            'grandparentTitle': f'Show {show}', 'thumb': f'/t/e{e}', 'grandparentThumb': f'/t/s{show}',
            'duration': 2_400_000, 'viewOffset': 600_000 if e == 3 else 0, 'viewCount': 1 if e < 3 else 0,
            'summary': 'Things happen in this episode. ' * 8}

def full(rk):
    if rk.startswith('m'):
        d = dict(next(m for m in MOVIES if m['ratingKey'] == rk))
        if rk in ('m3', 'm4'):  # MKV -> must go HLS (m3: server refuses, m4: real HLS)
            d['Media'] = [{'container': 'mkv', 'videoCodec': 'hevc', 'audioCodec': 'eac3', 'audioChannels': 6, 'width': 3840, 'height': 2160, 'videoResolution': '4k',
                           'Part': [{'key': '/library/parts/3/1/file.mkv'}]}]
        else:
            d['Media'] = [{'container': 'mp4', 'videoCodec': 'h264', 'audioCodec': 'aac', 'audioChannels': 2, 'width': 1280, 'height': 720, 'videoResolution': '720',
                           'Part': [{'key': f'/library/parts/{rk}/1/file.mp4'}]}]
        return d
    if rk.startswith('e'):
        _, s, se, e = re.match(r'e(\d+)_(\d+)_(\d+)', rk).group(0), *re.match(r'e(\d+)_(\d+)_(\d+)', rk).groups()
        d = episode(int(s), int(se), int(e))
        d['Media'] = [{'container': 'mp4', 'videoCodec': 'h264', 'audioCodec': 'aac', 'width': 1280, 'height': 720, 'videoResolution': '720',
                       'Part': [{'key': f'/library/parts/{rk}/1/file.mp4'}]}]
        return d
    if rk.startswith('se'):
        return {'ratingKey': rk, 'type': 'season', 'leafCount': 10, 'viewedLeafCount': 3}
    return next(s for s in SHOWS if s['ratingKey'] == rk)

def j(route, data, status=200):
    route.fulfill(status=status, body=json.dumps(data), headers={'content-type': 'application/json', 'access-control-allow-origin': '*'})

def plextv(route):
    req = route.request
    u = urlparse(req.url); q = parse_qs(u.query); p = u.path
    log.append(('plextv', req.method, p, q.get('X-Plex-Token', [''])[0], q.get('pin', [''])[0]))
    if req.method == 'OPTIONS':
        return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
    if p == '/api/v2/pins' and req.method == 'POST': return j(route, {'id': 42, 'code': 'AB12', 'expiresIn': 900})
    if p == '/api/v2/pins/42':
        pin_polls['n'] += 1
        return j(route, {'id': 42, 'authToken': 'acct-token' if pin_polls['n'] >= 2 else None})
    if p == '/api/v2/user':
        return j(route, {'username': 'griffon', 'title': 'Griffon'}) if q.get('X-Plex-Token') == ['acct-token'] else j(route, {}, 401)
    if p == '/api/v2/home/users':
        return j(route, {'id': 1, 'users': [{'id': 1, 'uuid': 'u1', 'title': 'Griffon', 'admin': True, 'protected': False},
                                            {'id': 2, 'uuid': 'u2', 'title': 'Kid', 'protected': True}]})
    if p == '/api/v2/home/users/u1/switch': return j(route, {'authToken': 'admin-token'})
    if p == '/api/v2/home/users/u2/switch':
        return j(route, {'authToken': 'kid-token'}) if q.get('pin') == ['1234'] else j(route, {'error': 'bad pin'}, 403)
    if p == '/api/v2/resources':
        return j(route, [{'name': 'Unraid', 'clientIdentifier': 'm1', 'provides': 'server', 'owned': True,
                          'accessToken': 'srv-token-' + q.get('X-Plex-Token', ['?'])[0],
                          'connections': [{'uri': 'http://192.168.1.8:32400', 'local': True, 'relay': False, 'protocol': 'http'},
                                          {'uri': 'https://1-2-3-4.abc123.plex.direct:32400', 'local': False, 'relay': False, 'protocol': 'https'},
                                          {'uri': SRV, 'local': True, 'relay': False, 'protocol': 'https'}]},
                         {'name': 'SomeClient', 'provides': 'client,player', 'connections': []}])
    return j(route, {'error': 'unmocked ' + p}, 404)

def pms(route):
    req = route.request
    u = urlparse(req.url); q = parse_qs(u.query); p = u.path
    if not u.netloc.startswith('192-168-1-8'):  # remote connection unreachable
        return route.abort('connectionrefused')
    tok = q.get('X-Plex-Token', [''])[0]
    log.append(('pms', req.method, p, tok, {k: v[0] for k, v in q.items() if not k.startswith('X-Plex-') or k in ('X-Plex-Container-Start', 'X-Plex-Session-Identifier', 'X-Plex-Client-Profile-Extra')}))
    if not tok.startswith('srv-token'): return j(route, {}, 401)
    if p == '/identity': return j(route, {'MediaContainer': {'machineIdentifier': 'm1'}})
    if p == '/library/sections':
        return j(route, {'MediaContainer': {'Directory': [{'key': '1', 'title': 'Movies', 'type': 'movie'}, {'key': '2', 'title': 'TV Shows', 'type': 'show'}, {'key': '3', 'title': 'Music', 'type': 'artist'}]}})
    if p == '/library/onDeck':
        return j(route, {'MediaContainer': {'Metadata': [episode(1, 1, 3), MOVIES[2]]}})
    m = re.match(r'/library/sections/(\d)/all', p)
    if m:
        items = MOVIES if m.group(1) == '1' else SHOWS
        s = int(q.get('X-Plex-Container-Start', ['0'])[0]); n = int(q.get('X-Plex-Container-Size', ['50'])[0])
        return j(route, {'MediaContainer': {'totalSize': len(items), 'size': len(items[s:s + n]), 'Metadata': items[s:s + n]}})
    m = re.match(r'/library/metadata/([^/]+)/children', p)
    if m:
        rk = m.group(1)
        if rk.startswith('se'):
            sh, se = re.match(r'se(\d+)_(\d+)', rk).groups()
            return j(route, {'MediaContainer': {'Metadata': [episode(int(sh), int(se), e) for e in range(1, 11)]}})
        sh = int(rk[1:])
        return j(route, {'MediaContainer': {'Metadata': [{'ratingKey': f'se{sh}_{n}', 'type': 'season', 'title': f'Season {n}', 'index': n, 'parentTitle': f'Show {sh}',
                                                          'thumb': f'/t/se{n}', 'leafCount': 10, 'viewedLeafCount': 10 if n == 1 else 3} for n in (1, 2)]}})
    m = re.match(r'/library/metadata/([^/]+)$', p)
    if m: return j(route, {'MediaContainer': {'Metadata': [full(m.group(1))]}})
    if p == '/photo/:/transcode':
        idx = sum(map(ord, q.get('url', [''])[0])) % 4
        return route.fulfill(status=200, body=open(f'{MOCK}/p{idx}.png', 'rb').read(), headers={'content-type': 'image/png', 'access-control-allow-origin': '*'})
    if p.startswith('/library/parts/'):
        data = open(f'{MOCK}/test.webm', 'rb').read()
        rng = req.headers.get('range')
        hdr = {'content-type': 'video/mp4', 'access-control-allow-origin': '*', 'accept-ranges': 'bytes'}
        if rng:
            a, _, b = rng.replace('bytes=', '').partition('-')
            a = int(a); b = int(b) if b else len(data) - 1
            hdr['content-range'] = f'bytes {a}-{b}/{len(data)}'
            return route.fulfill(status=206, body=data[a:b + 1], headers=hdr)
        return route.fulfill(status=200, body=data, headers=hdr)
    if p.startswith('/video/:/transcode/universal/session/'):
        f = p.rsplit('/', 1)[1]
        ct = 'application/vnd.apple.mpegurl' if f.endswith('.m3u8') else 'video/mp4'
        return route.fulfill(status=200, body=open(f'{MOCK}/hls/{f}', 'rb').read(), headers={'content-type': ct, 'access-control-allow-origin': '*'})
    if p in ('/:/timeline', '/:/scrobble', '/:/unscrobble', '/video/:/transcode/universal/stop'): return j(route, {})
    if p == '/video/:/transcode/universal/start.m3u8' and q.get('path') == ['/library/metadata/m4']:
        sess = q.get('session')[0]
        body = f'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,CODECS="vp09.00.10.08,opus"\nsession/{sess}/base/index.m3u8\n'
        return route.fulfill(status=200, body=body, headers={'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*'})
    if p == '/video/:/transcode/universal/start.m3u8': return route.fulfill(status=400, body='mock: no transcoder', headers={'access-control-allow-origin': '*'})
    return j(route, {'error': 'unmocked ' + p}, 404)

errors = []
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = b.new_page(viewport={'width': 1600, 'height': 1000})
    page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'PAGEERROR: {e}'))
    page.route(re.compile(r'https://plex\.tv/.*'), plextv)
    page.route(re.compile(r'https://[^/]*plex\.direct(:\d+)?/.*'), pms)
    page.goto('http://127.0.0.1:8765/index.html?debug')

    def shot(name):
        page.wait_for_timeout(400); page.screenshot(path=f'{OUT}/{name}.png')

    def click_main(x, y, panel='mainPanel'):
        pt = page.evaluate("""([x,y,panel]) => { const d = window.__dbg, p = d[panel], m = p.mesh;
            const g = m.geometry.parameters; const v = new d.THREE.Vector3((x/p.W - .5)*g.width, (.5 - y/p.H)*g.height, 0);
            m.updateMatrixWorld(true); m.localToWorld(v); v.project(d.camera);
            return [(v.x+1)/2*innerWidth, (1-v.y)/2*innerHeight]; }""", [x, y, panel])
        page.mouse.move(pt[0], pt[1]); page.wait_for_timeout(120); page.mouse.click(pt[0], pt[1]); page.wait_for_timeout(300)

    def screen():
        return page.evaluate('window.__app.screen')

    page.wait_for_timeout(1500)
    if page.evaluate('!window.__app'): print('\n'.join(errors)); sys.exit(1)
    assert screen() == 'login', screen()
    shot('01_login')
    page.wait_for_function("window.__app.screen === 'users'", timeout=10000)
    shot('02_users')
    # users laid out: 2 users, tile 260 gap 60 centered at W/2; Kid is second
    click_main(2048 / 2 + 30 + 130, 470 + 130)
    assert screen() == 'pin', screen()
    for k, (cx, cy) in {'1': (0, 0), '2': (1, 0)}.items():
        pass
    def key(k):
        keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Cancel', '0', '⌫']
        i = keys.index(k); bw, bh, gap = 220, 170, 28
        x0 = 2048 / 2 - (3 * bw + 2 * gap) / 2
        click_main(x0 + (i % 3) * (bw + gap) + bw / 2, 390 + (i // 3) * (bh + gap) + bh / 2)
    for k in '9999': key(k)
    page.wait_for_function("window.__app.screen === 'pin'", timeout=5000)
    shot('03_pin_wrong')
    for k in '1234': key(k)
    page.wait_for_function("window.__app.screen === 'browse'", timeout=10000)
    page.wait_for_timeout(1200)
    shot('04_ondeck')
    used_conn = page.evaluate('window.__app.server.uri')
    print('connected via', used_conn, 'token', page.evaluate('window.__app.server.token'))

    # Movies library (sidebar entry index 1 at y=160+88)
    click_main(150, 160 + 88 + 40)
    page.wait_for_timeout(1500)
    shot('05_movies')
    # scroll down a lot to trigger paging
    for _ in range(12):
        page.mouse.wheel(0, 900); page.wait_for_timeout(150)
    page.wait_for_timeout(1500)
    n_loaded = page.evaluate("window.__app.lists.get('sec:1').items.length")
    print('movies loaded after scroll:', n_loaded)
    shot('06_movies_scrolled')
    # back to top, open movie index 2 (resume)
    page.evaluate("window.__app.top().scroll = 0; window.__app.inv()")
    page.wait_for_timeout(300)
    CARD_W = (1600 - 24 * 6) / 7
    click_main(420 + 2 * (CARD_W + 24) + CARD_W / 2, 140 + 150)
    page.wait_for_timeout(1200)
    print('top after click:', page.evaluate('window.__app.top().kind'), page.evaluate('window.__app.top().item?.ratingKey'))
    shot('07_detail_resume')
    # click Resume (detail layout: x = CX+PW+60, buttons at by)
    click_main(420 + 440 + 60 + 190, 0, ) if False else None
    resume = page.evaluate("(() => { const r = window.__dbg.mainPanel.regions.find(r => r.id === 'resume'); return r && [r.x + r.w/2, r.y + r.h/2]; })()")
    print('resume region', resume)
    click_main(*resume)
    page.wait_for_timeout(3000)
    st = page.evaluate("[window.__app.inPlayer, window.__dbg.player.state, window.__dbg.player.mode, window.__dbg.player.positionMs, window.__dbg.screenGroup.visible]")
    print('player:', st)
    shot('08_playing')
    # seek via control +30
    c = page.evaluate("(() => { const r = window.__dbg.ctrlPanel.regions.find(r => r.id === 'c:5'); return r && [r.x + r.w/2, r.y + r.h/2]; })()")
    print('pos before +30:', page.evaluate('window.__dbg.player.positionMs'), 'ctrl visible', page.evaluate('window.__dbg.ctrlPanel.mesh.visible'), c)
    click_main(*c, panel='ctrlPanel')
    print('hover after click:', page.evaluate('window.__dbg.ctrlPanel.hover'), 'seeking', page.evaluate('window.__dbg.player.video.seeking'), page.evaluate('window.__dbg.player.video.currentTime'))
    page.wait_for_timeout(800)
    print('pos after +30:', page.evaluate('window.__dbg.player.positionMs'))
    # stop
    c = page.evaluate("(() => { const r = window.__dbg.ctrlPanel.regions.find(r => r.id === 'c:0'); return r && [r.x + r.w/2, r.y + r.h/2]; })()")
    click_main(*c, panel='ctrlPanel')
    page.wait_for_timeout(1200)
    print('after stop inPlayer:', page.evaluate('window.__app.inPlayer'), 'screen', screen())
    shot('09_after_stop')

    # HEVC/MKV item -> HLS path (movie m3)
    page.evaluate("window.__app.startPlayback({ratingKey: 'm3', type: 'movie', title: 'x'}, 0)")
    page.wait_for_timeout(4000)
    print('hls refused:', page.evaluate("[window.__dbg.player.mode, window.__dbg.player.state, window.__app.playerMsg]"))
    shot('10_hls_error')
    page.keyboard.press('Escape'); page.wait_for_timeout(800)

    # real HLS stream: play, seek inside buffer (native) and far ahead (transcode restart with offset)
    page.evaluate("window.__app.startPlayback({ratingKey: 'm4', type: 'movie', title: 'x'}, 0)")
    try:
        page.wait_for_function("window.__dbg.player.state === 'playing'", timeout=15000)
    except Exception:
        print('HLS FAIL', page.evaluate("[window.__dbg.player.state, window.__app.playerMsg, window.__dbg.player.video.error?.message]"))
        print('\n'.join(errors[-15:]))
        print([l for l in log if 'transcode' in l[2] or 'session' in l[2]])
        raise
    page.wait_for_timeout(2500)
    print('hls playing:', page.evaluate("[window.__dbg.player.mode, window.__dbg.player.positionMs, window.__dbg.player.video.muted]"))
    shot('15_hls_playing')
    page.evaluate("window.__dbg.player.seekBy(1000)"); page.wait_for_timeout(300)
    print('hls after small seek:', page.evaluate("window.__dbg.player.positionMs"))
    page.keyboard.press('ArrowRight'); page.keyboard.press('ArrowRight'); page.keyboard.press('ArrowRight')
    page.evaluate("window.__dbg.player.seekTo(600000)")
    page.wait_for_timeout(300)
    print('pending:', page.evaluate("window.__dbg.player.pendingSeekMs"))
    page.wait_for_function("window.__dbg.player.state === 'playing' && window.__dbg.player.pendingSeekMs == null", timeout=15000)
    page.wait_for_timeout(1500)
    print('hls after far seek:', page.evaluate("[window.__dbg.player.baseOffsetMs, window.__dbg.player.positionMs]"))
    page.keyboard.press('Escape'); page.wait_for_timeout(800)
    # direct play native seek with range support
    page.evaluate("window.__app.startPlayback({ratingKey: 'm7', type: 'movie', title: 'x'}, 30000)")
    page.wait_for_function("window.__dbg.player.state === 'playing'", timeout=15000)
    page.wait_for_timeout(800)
    print('direct start@30s pos:', page.evaluate("window.__dbg.player.positionMs"))
    page.evaluate("window.__dbg.player.seekBy(-20000)"); page.wait_for_timeout(1200)
    print('direct after -20s:', page.evaluate("window.__dbg.player.positionMs"))
    page.keyboard.press('Escape'); page.wait_for_timeout(800)

    # TV: show -> season -> episodes
    page.evaluate("window.__app.goRoot({kind:'section', section: window.__app.sections[1], title:'TV Shows'})")
    page.wait_for_timeout(1500); shot('11_shows')
    page.evaluate("window.__app.openItem(window.__app.lists.get('sec:2').items[0])"); page.wait_for_timeout(1200); shot('12_seasons')
    page.evaluate("window.__app.openItem(window.__app.lists.get('kids:s0').items[1])"); page.wait_for_timeout(1500); shot('13_episodes')
    page.evaluate("window.__app.openItem(window.__app.lists.get('kids:se0_2').items[2])"); page.wait_for_timeout(1500); shot('14_ep_detail')
    page.keyboard.press('Escape'); page.wait_for_timeout(300)
    print('after esc top:', page.evaluate('window.__app.top().kind'))
    httpd.shutdown()
    b.close()

print('\n--- requests ---')
for l in log:
    if l[0] == 'pms' and l[2] in ('/photo/:/transcode',): continue
    print(l)
print('\n--- console errors/warnings ---')
for e in errors: print(e)
