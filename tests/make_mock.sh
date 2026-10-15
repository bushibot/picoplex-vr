#!/usr/bin/env bash
# Generates mock media for tests/e2e_mock.py (VP8/VP9 because headless Chromium has no H.264).
set -euo pipefail
M="$(cd "$(dirname "$0")" && pwd)/mock"; mkdir -p "$M/hls"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 60 -c:v libvpx -b:v 1M -c:a libvorbis "$M/test.webm"
ffmpeg -loglevel error -y -i "$M/test.webm" -c:v libvpx-vp9 -b:v 800k -deadline realtime -cpu-used 8 -c:a libopus -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$M/hls/seg%03d.m4s" "$M/hls/index.m3u8"
python3 - "$M" <<'PY'
import sys
from PIL import Image, ImageDraw
for i, c in enumerate([(120,60,160),(40,110,150),(150,90,40),(60,140,80)]):
    im = Image.new('RGB', (300, 450), c); ImageDraw.Draw(im).rectangle([20,20,280,430], outline=(255,255,255), width=6); im.save(f'{sys.argv[1]}/p{i}.png')
PY
echo "mock media in $M"
