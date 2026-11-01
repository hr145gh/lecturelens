/**
 * Cuts the evaluation clips listed in manifest.json from the source recording.
 *   npx tsx evaluation/asr/make-clips.ts [path/to/source-recording]
 * Default source: manifest.sourceRecording.path (relative to the repository root). Its md5 is
 * checked so the clips always match the typed references. Output: evaluation/asr/clips/*.wav
 * (mono 16 kHz PCM, the format the pipeline itself sends to the providers).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

interface ClipEntry {
  id: string;
  clip: string;
  source: { startSec: number; endSec: number };
  noise?: { type: 'pink' | 'white' | 'brown'; snrDb: number; seed: number };
}
interface Manifest {
  sourceRecording: { path: string; md5: string };
  clips: ClipEntry[];
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`))));
  });
}

async function md5(file: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Mean volume in dBFS (ffmpeg volumedetect). */
async function meanVolumeDb(file: string): Promise<number> {
  const out = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume: (-?[\d.]+) dB/.exec(out);
  if (!m) throw new Error(`could not measure the volume of ${file}`);
  return Number(m[1]);
}

const PCM = ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8')) as Manifest;
  const source = path.resolve(ROOT, process.argv[2] ?? manifest.sourceRecording.path);
  const actual = await md5(source);
  if (actual !== manifest.sourceRecording.md5) {
    throw new Error(`source recording md5 is ${actual}, manifest expects ${manifest.sourceRecording.md5} — wrong file?`);
  }
  await mkdir(path.join(HERE, 'clips'), { recursive: true });

  // Clean clips first: noisy variants are built from them.
  const clean = new Map<string, string>();
  for (const c of manifest.clips.filter((c) => !c.noise)) {
    const out = path.join(HERE, c.clip);
    await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(c.source.startSec), '-to', String(c.source.endSec), '-i', source, ...PCM, out]);
    clean.set(`${c.source.startSec}-${c.source.endSec}`, out);
    console.log(`${c.id.padEnd(10)} ${c.source.startSec.toFixed(2)}–${c.source.endSec.toFixed(2)} s → ${c.clip}`);
  }

  for (const c of manifest.clips.filter((c) => c.noise)) {
    const base = clean.get(`${c.source.startSec}-${c.source.endSec}`);
    if (!base || !c.noise) throw new Error(`${c.id}: no clean clip with the same source span to add noise to`);
    const duration = c.source.endSec - c.source.startSec;
    const noiseFile = path.join(HERE, 'clips', `.${c.id}.noise.wav`);
    await run('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i',
      `anoisesrc=color=${c.noise.type}:seed=${c.noise.seed}:sample_rate=16000:duration=${duration}`, ...PCM, noiseFile]);
    // Scale the noise so (speech level − noise level) equals the requested SNR, then mix.
    const gainDb = (await meanVolumeDb(base)) - c.noise.snrDb - (await meanVolumeDb(noiseFile));
    const out = path.join(HERE, c.clip);
    await run('ffmpeg', ['-hide_banner', '-y', '-i', base, '-i', noiseFile, '-filter_complex',
      `[1:a]volume=${gainDb.toFixed(2)}dB[n];[0:a][n]amix=inputs=2:duration=first:normalize=0`, ...PCM, out]);
    // Verify: level of (mix − speech) is the noise actually added.
    const residual = path.join(HERE, 'clips', `.${c.id}.residual.wav`);
    await run('ffmpeg', ['-hide_banner', '-y', '-i', out, '-i', base, '-filter_complex',
      '[1:a]volume=-1[s];[0:a][s]amix=inputs=2:duration=first:normalize=0', ...PCM, residual]);
    const achievedSnr = (await meanVolumeDb(base)) - (await meanVolumeDb(residual));
    await rm(noiseFile, { force: true });
    await rm(residual, { force: true });
    console.log(`           measured SNR ${achievedSnr.toFixed(1)} dB`);
    console.log(`${c.id.padEnd(10)} ${c.id.replace(/-noisy$/, '')} + ${c.noise.type} noise at ${c.noise.snrDb} dB SNR (noise gain ${gainDb.toFixed(2)} dB) → ${c.clip}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
