# Project-level skills

Skills vendored here are discovered automatically by Claude Code when working
in this repository.

## brag

`brag/` is a vendored copy of [latent-spaces/brag](https://github.com/latent-spaces/brag)
(MIT, Shunit Haviv Hakimi) at commit `1e2df63`. Invoke it as `/brag`. It turns
the current project into a short launch video.

The skill itself is self-contained, but it delegates composition and rendering
to Hyperframes, which is **not** vendored. Steps 1-2 (inspect, plan,
storyboard) work with no extra setup. Steps 3-4 (compose, render) need:

```text
apt-get install -y ffmpeg        # FFmpeg + FFprobe on PATH
npx hyperframes skills           # hyperframes-core/-animation/-creative/-keyframes/-cli
npx hyperframes browser ensure   # Chrome Headless Shell (~114 MB)
npx hyperframes doctor           # verify: FFmpeg, FFprobe, Chrome must be green
```

Node 22+ is required for the Hyperframes CLI. The repository's own test suite
still targets Node 16 and does not depend on any of the above.

### Sandboxed environments

Scaffolded Hyperframes compositions load GSAP from `cdn.jsdelivr.net`. Where
egress policy blocks that host, `hyperframes check` fails with
`ERR_TUNNEL_CONNECTION_FAILED` and `gsap is not defined` even though the
install is sound. Vendor GSAP from npm instead:

```text
npm install gsap@3.14.2
mkdir -p vendor && cp node_modules/gsap/dist/gsap.min.js vendor/gsap.min.js
```

Then point the composition's `<script src="...gsap.min.js">` at
`vendor/gsap.min.js`.

Note: the Hyperframes CLI reports anonymous usage data by default. Disable it
with `npx hyperframes telemetry disable`.
