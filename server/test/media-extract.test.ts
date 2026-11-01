
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudio, probeDuration } from '../src/services/media/extract.js';

let tempDir: string;
let wavPath: string;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.once('error', reject);

    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
      }
    });
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'lecturelens-media-'));
  wavPath = path.join(tempDir, 'fixture.wav');

  // Generate a 2-second mono, 16 kHz PCM WAV fixture.
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=2',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    wavPath,
  ]);
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('media extraction', () => {
  it('probes duration in seconds', async () => {
    const duration = await probeDuration(wavPath);

    expect(duration).toBeGreaterThan(1.9);
    expect(duration).toBeLessThanOrEqual(2.1);
  });

  it('skips re-encoding an already compatible WAV', async () => {
    const result = await extractAudio(wavPath);

    expect(result.audioPath).toBe(wavPath);
    expect(result.durationSec).toBeGreaterThan(1.9);
    expect(result.durationSec).toBeLessThanOrEqual(2.1);
  });

  it('extracts audio from a non-WAV input', async () => {
    const inputPath = path.join(tempDir, 'fixture.mp3');

    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-i', wavPath,
      '-c:a', 'libmp3lame',
      inputPath,
    ]);

    const result = await extractAudio(inputPath);

    expect(result.audioPath).toBe(path.join(tempDir, 'fixture.audio.wav'));
    expect(result.durationSec).toBeGreaterThan(1.9);
    expect(result.durationSec).toBeLessThanOrEqual(2.1);

    const outputDuration = await probeDuration(result.audioPath);
    expect(outputDuration).toBeGreaterThan(1.9);
    expect(outputDuration).toBeLessThanOrEqual(2.1);
  });
});
