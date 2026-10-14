# Chrome Web Store capture source

`parse.jpg`, `preview.jpg`, `history.jpg`, and `agent.jpg` are 1280×1000 JPEG screenshots of the extension 0.2.5 candidate in this branch. They use the current built extension HTML, CSS, and JavaScript in an isolated local tab. `capture-fixture.js` supplies synthetic `chrome.*` APIs and sample data before the built UI loads; the extension was not installed in Chrome. Run `capture-fixture-selfcheck.mjs` to verify its message, storage, and download-history behavior without opening a browser.

The fixture does not sign in, read a browser profile, contact the upstream parser, invoke Native Messaging, or download files. `?capture=empty` shows the parsed result without recent records, the default mode shows one recent record, and `?capture=history` shows seven synthetic history records.

`agent.jpg` shows the actual **Agent 设置** popover with its ordinary **复制提示词** button and Icons8 credit visible. Its instance UUID and extension ID are synthetic. No connection or login snapshot is supplied, so the UI reports an unknown connection state; the screenshot does not claim a successful connection or login, and the copy action is not triggered.

## Reproduce

Build the current candidate, then copy its output into external scratch space:

```sh
capture_tmp=/Volumes/2T/.codex/tmp/store-capture-025
/Volumes/2T/.codex/bin/external-dev /Volumes/2T/.codex/bin/heavy-dev node scripts/build.mjs --release --component extension
/Volumes/2T/.codex/bin/external-dev mkdir -p "$capture_tmp"
/Volumes/2T/.codex/bin/external-dev cp -R dist/extension "$capture_tmp/extension"
```

Run the fixture checks:

```sh
/Volumes/2T/.codex/bin/external-dev /Volumes/2T/.codex/bin/heavy-dev node docs/chrome-web-store/captures/capture-fixture-selfcheck.mjs
```

Generate the local, silent 2-second sample video used by the preview:

```sh
/Volumes/2T/.codex/bin/external-dev /Volumes/2T/.codex/bin/heavy-dev /opt/homebrew/bin/ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=0x9ac4ca:s=640x360:d=2:r=12' \
  -vf 'drawbox=x=0:y=176:w=iw:h=184:color=0x2e7f8e:t=fill,drawbox=x=0:y=264:w=iw:h=96:color=0xe4c690:t=fill,drawbox=x=448:y=40:w=60:h=60:color=0xf4c875:t=fill' \
  -c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p -movflags +faststart \
  /Volumes/2T/.codex/tmp/store-capture-025/capture-preview.mp4
```

Copy the fixture and local assets into the scratch build, inject the classic fixture script before the bundled module script, then serve the build on localhost:

```sh
capture_extension=/Volumes/2T/.codex/tmp/store-capture-025/extension
/Volumes/2T/.codex/bin/external-dev cp docs/chrome-web-store/captures/capture-fixture.js "$capture_extension/capture-fixture.js"
/Volumes/2T/.codex/bin/external-dev cp docs/chrome-web-store/captures/capture-cover.svg "$capture_extension/capture-cover.svg"
/Volumes/2T/.codex/bin/external-dev cp /Volumes/2T/.codex/tmp/store-capture-025/capture-preview.mp4 "$capture_extension/capture-preview.mp4"
/Volumes/2T/.codex/bin/external-dev python3 -c 'from pathlib import Path; p=Path("/Volumes/2T/.codex/tmp/store-capture-025/extension/index.html"); html=p.read_text(); old="<script type=\"module\" src=\"./agent.js\"></script>"; new="<script src=\"./capture-fixture.js\"></script>\n    " + old; assert html.count(old) == 1; p.write_text(html.replace(old, new, 1))'
/Volumes/2T/.codex/bin/external-dev python3 -m http.server 4173 --bind 127.0.0.1 --directory "$capture_extension"
```

Open `http://127.0.0.1:4173/index.html?capture=empty` in a local browser and enter `https://weixin.qq.com/sph/demo-capture-025` to show the result. Open `http://127.0.0.1:4173/index.html?capture=history` and choose **查看全部** for the history view. These screenshots were captured from the browser's 1280×1000 viewport using CUA `getScreenshot()` and saved with `node:fs/promises.writeFile`.

To reproduce `agent.jpg`, open the `?capture=empty` page, leave the input empty, and open **Agent 设置** without clicking **复制提示词**.

The MP4 is generated scratch input under `/Volumes/2T/.codex/tmp` and is excluded from source control; only the small SVG, fixture, self-check, and JPEG captures belong in source control.
