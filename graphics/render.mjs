// ── Deterministic spec → graphics pipeline ───────────────────────────────────
// One command turns a video spec into finished deliverables:
//
//   node render.mjs spec/<video>.json <outputFolder>
//
// For each entry in the spec it renders the composition to ProRes 4444 WITH
// ALPHA (the --pixel-format flag below is load-bearing: without it Remotion
// silently emits yuv422 and the graphic gets an opaque black background), then
// writes manifest.json — timing comes from the SAME spec entries, so renders
// and manifest can never drift apart. The FirstPass "Graphics" tab consumes the
// output folder directly.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [specPath, outDir] = process.argv.slice(2);
if (!specPath || !outDir) {
  console.error("usage: node render.mjs spec/<video>.json <outputFolder>");
  process.exit(1);
}

const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));
mkdirSync(resolve(outDir), { recursive: true });

// Root.tsx statically imports spec/active.json — point it at this spec.
copyFileSync(resolve(specPath), resolve(HERE, "spec/active.json"));

for (const g of spec.graphics) {
  const out = resolve(outDir, g.file);
  console.log(`\n▶ ${g.id} → ${g.file} (${g.durationSec}s @ ${g.startSec}s)`);
  // Invoke the local CLI via this node binary — `npx` isn't on the bare PATH
  // the helper daemon inherits from launchd.
  const r = spawnSync(process.execPath, [
    resolve(HERE, "node_modules/@remotion/cli/remotion-cli.js"),
    "render", "src/index.ts", g.id, out,
    "--codec=prores", "--prores-profile=4444",
    "--pixel-format=yuva444p10le",          // REQUIRED for the alpha channel
    "--muted",                              // graphics are silent — Remotion
                                            // otherwise muxes a PCM track that
                                            // lands on the editor's timeline
  ], { cwd: HERE, stdio: "inherit" });
  if (r.status !== 0) { console.error(`render failed for ${g.id}`); process.exit(r.status ?? 1); }
}

// manifest.json — the contract the plugin's Graphics tab reads.
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceTranscript: spec.sourceTranscript,
  renderer: "remotion",
  sequence: spec.sequence,
  graphics: spec.graphics.map(({ file, startSec, durationSec, label }) =>
    ({ file, startSec, durationSec, label })),
};
writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n✔ wrote ${spec.graphics.length} graphics + manifest.json to ${resolve(outDir)}`);
