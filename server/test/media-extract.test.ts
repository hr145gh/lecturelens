import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudio, makeBrowserPlayable, MediaProcessingError, mp4Layout, probeDuration } from '../src/services/media/extract.js';

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

  it('writes a mono 16 kHz PCM WAV with the exact ffmpeg settings', async () => {
    const inputPath = path.join(tempDir, 'stereo44k.mp3');
    await runFfmpeg(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1:sample_rate=44100', '-ac', '2', inputPath]);
    const { audioPath } = await extractAudio(inputPath);
    const info = await new Promise<string>((resolve) => {
      const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', audioPath]);
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', () => resolve(out.trim()));
    });
    expect(info).toBe('pcm_s16le,16000,1');
  });

  it('a video without an audio track fails with NO_AUDIO_STREAM, not a generic error', async () => {
    const inputPath = path.join(tempDir, 'silent-video.mkv');
    await runFfmpeg(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5', '-c:v', 'mjpeg', inputPath]);
    const error = await extractAudio(inputPath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaProcessingError);
    expect((error as MediaProcessingError).code).toBe('NO_AUDIO_STREAM');
  });

  it('a file that is not media fails with PROBE_FAILED and keeps ffprobe\'s reason', async () => {
    const inputPath = path.join(tempDir, 'not-media.mp3');
    await (await import('node:fs/promises')).writeFile(inputPath, 'this is not audio');
    const error = await extractAudio(inputPath).catch((e: unknown) => e);
    expect((error as MediaProcessingError).code).toBe('PROBE_FAILED');
    expect((error as Error).message).toMatch(/ffprobe exited with code 1/);
  });
});

// Regression: a fragmented MP4 upload (moov declares duration 0) played as "1:42" in the browser
// while the lecture was 9:42. The extract stage now rewrites such files losslessly before anything else.
describe('browser-playable MP4 (makeBrowserPlayable)', () => {
  const av = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest'];

  it('rewrites a fragmented MP4 as a regular faststart MP4 in place, same duration, stream copy', async () => {
    const file = path.join(tempDir, 'fragmented.mp4');
    await runFfmpeg(['-hide_banner', '-y', ...av, '-movflags', 'frag_keyframe+empty_moov', file]);
    expect(await mp4Layout(file)).toEqual({ fragmented: true, moovFirst: true });
    const before = await probeDuration(file);

    expect(await makeBrowserPlayable(file)).toBe(true);
    expect(await mp4Layout(file)).toEqual({ fragmented: false, moovFirst: true });
    expect(await probeDuration(file)).toBeCloseTo(before, 1);
    expect(await makeBrowserPlayable(file)).toBe(false); // already playable: untouched
  });

  it('moves a trailing moov to the front (faststart)', async () => {
    const file = path.join(tempDir, 'moov-at-end.mp4');
    await runFfmpeg(['-hide_banner', '-y', ...av, file]); // ffmpeg's default MP4 layout: moov after mdat
    expect(await mp4Layout(file)).toEqual({ fragmented: false, moovFirst: false });
    expect(await makeBrowserPlayable(file)).toBe(true);
    expect(await mp4Layout(file)).toEqual({ fragmented: false, moovFirst: true });
  });

  it('leaves non-MP4 files alone, and never throws on a broken MP4', async () => {
    expect(await makeBrowserPlayable(wavPath)).toBe(false);
    expect(await mp4Layout(wavPath)).toBeNull();
    const broken = path.join(tempDir, 'broken.mp4');
    await (await import('node:fs/promises')).writeFile(broken, 'not an mp4 at all');
    expect(await makeBrowserPlayable(broken)).toBe(false);
  });
});
