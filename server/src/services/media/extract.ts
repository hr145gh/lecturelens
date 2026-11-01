import { spawn } from 'node:child_process';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export type MediaProcessingErrorCode =
  | 'FFMPEG_NOT_FOUND'
  | 'FFPROBE_NOT_FOUND'
  | 'PROBE_FAILED'
  | 'NO_AUDIO_STREAM'
  | 'EXTRACTION_FAILED';

/** The platform's FFmpeg install command, for "not found" errors. */
export function ffmpegInstallHint(): string {
  if (process.platform === 'win32') return 'winget install Gyan.FFmpeg';
  if (process.platform === 'darwin') return 'brew install ffmpeg';
  return 'sudo apt install ffmpeg';
}

export class MediaProcessingError extends Error {
  constructor(
    public readonly code: MediaProcessingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MediaProcessingError';
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  missingCode: 'FFMPEG_NOT_FOUND' | 'FFPROBE_NOT_FOUND',
  failureCode: 'PROBE_FAILED' | 'EXTRACTION_FAILED',
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new MediaProcessingError(
            missingCode,
            `${command} was not found. Install FFmpeg using: ${ffmpegInstallHint()}`,
            { cause: error },
          ),
        );
        return;
      }

      reject(
        new MediaProcessingError(
          failureCode,
          `Unable to run ${command}: ${error.message}`,
          { cause: error },
        ),
      );
    });

    child.once('close', (code) => {
      if (code !== 0) {
        if (stderr.trim()) {
          logger.error(`${command} stderr: ${stderr.trim()}`);
        }

        reject(
          new MediaProcessingError(
            failureCode,
            `${command} exited with code ${code}. stderr: ${stderr.trim() || '(empty)'}`,
          ),
        );
        return;
      }

      if (stderr.trim()) {
        logger.info(`${command} stderr: ${stderr.trim()}`);
      }

      resolve({ stdout, stderr });
    });
  });
}

export async function probeDuration(inputPath: string): Promise<number> {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ],
    'FFPROBE_NOT_FOUND',
    'PROBE_FAILED',
  );

  const durationSec = Number.parseFloat(stdout.trim());

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new MediaProcessingError(
      'PROBE_FAILED',
      `ffprobe returned an invalid duration for "${inputPath}": ${stdout.trim()}`,
    );
  }

  return Number(durationSec.toFixed(3));
}

/** Probes the first audio stream; throws NO_AUDIO_STREAM if there is none. */
async function isMono16KhzWav(inputPath: string): Promise<boolean> {
  const { stdout } = await runCommand(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels',
      '-show_entries', 'format=format_name',
      '-of', 'json',
      inputPath,
    ],
    'FFPROBE_NOT_FOUND',
    'PROBE_FAILED',
  );

  const metadata = JSON.parse(stdout) as {
    streams?: Array<{
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
    }>;
    format?: { format_name?: string };
  };

  const stream = metadata.streams?.[0];
  if (!stream) {
    throw new MediaProcessingError('NO_AUDIO_STREAM', 'The uploaded file has no audio track to transcribe.');
  }

  return (
    metadata.format?.format_name?.split(',').includes('wav') === true &&
    stream?.codec_name === 'pcm_s16le' &&
    stream.sample_rate === '16000' &&
    stream.channels === 1
  );
}

export async function extractAudio(
  inputPath: string,
): Promise<{ audioPath: string; durationSec: number }> {
  const absoluteInputPath = path.resolve(inputPath);
  const durationSec = await probeDuration(absoluteInputPath);

  if (await isMono16KhzWav(absoluteInputPath)) {
    return { audioPath: absoluteInputPath, durationSec };
  }

  const parsed = path.parse(absoluteInputPath);
  const audioPath = path.join(parsed.dir, `${parsed.name}.audio.wav`);

  await runCommand(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      '-i', absoluteInputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      audioPath,
    ],
    'FFMPEG_NOT_FOUND',
    'EXTRACTION_FAILED',
  );

  return { audioPath, durationSec };
}

/* ------------------------------------------------------------ browser-playable MP4 ---- */

/** Containers in the ISO base media (MP4/QuickTime) family. */
const ISO_BMFF_EXTENSIONS = new Set(['.mp4', '.m4v', '.m4a', '.mov']);

export interface Mp4Layout {
  /** Has `moof` fragments: the `moov` header then usually declares duration 0, so a browser only
   *  learns the length as it reads fragments (e.g. a 9:42 recording shown as 1:42). */
  fragmented: boolean;
  /** `moov` comes before `mdat`, so playback can start without reading to the end of the file. */
  moovFirst: boolean;
}

/** Top-level box layout of an MP4-family file; null when the file is not one. Reads box headers only. */
export async function mp4Layout(filePath: string): Promise<Mp4Layout | null> {
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    let first = true;
    let moovAt = -1;
    let mdatAt = -1;
    let fragmented = false;
    while (offset + 8 <= size) {
      await file.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (first && type !== 'ftyp') return null;
      first = false;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - offset; // box runs to the end of the file
      if (boxSize < 8) return null; // corrupt: stop instead of looping
      if (type === 'moov' && moovAt < 0) moovAt = offset;
      if (type === 'mdat' && mdatAt < 0) mdatAt = offset;
      if (type === 'moof') fragmented = true;
      if (fragmented && moovAt >= 0 && mdatAt >= 0) break;
      offset += boxSize;
    }
    if (moovAt < 0) return null;
    return { fragmented, moovFirst: mdatAt < 0 || moovAt < mdatAt };
  } finally {
    await file.close();
  }
}

/**
 * Rewrites an uploaded MP4/MOV in place as a regular, "faststart" file when its layout keeps the
 * browser from knowing the duration or starting quickly (fragmented, or `moov` after `mdat`).
 * Stream copy only (`-c copy`): no re-encoding, no quality change, same streams. Never throws —
 * a file that cannot be remuxed is left as uploaded (playback may then show a wrong duration,
 * but processing continues). Returns true when the file was rewritten.
 */
export async function makeBrowserPlayable(inputPath: string): Promise<boolean> {
  const absoluteInputPath = path.resolve(inputPath);
  const parsed = path.parse(absoluteInputPath);
  if (!ISO_BMFF_EXTENSIONS.has(parsed.ext.toLowerCase())) return false;

  const layout = await mp4Layout(absoluteInputPath).catch(() => null);
  if (!layout || (!layout.fragmented && layout.moovFirst)) return false;

  const remuxPath = path.join(parsed.dir, `${parsed.name}.remux${parsed.ext}`);
  try {
    await runCommand(
      'ffmpeg',
      ['-hide_banner', '-y', '-i', absoluteInputPath, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', remuxPath],
      'FFMPEG_NOT_FOUND',
      'EXTRACTION_FAILED',
    );
    const remuxed = await mp4Layout(remuxPath);
    if (!remuxed || remuxed.fragmented || !remuxed.moovFirst) throw new Error('remuxed file is still not faststart');
    await rename(remuxPath, absoluteInputPath); // atomic: an open media stream keeps the old file
    logger.info('Remuxed the upload into a browser-playable MP4 (stream copy)', { file: parsed.base, was: layout });
    return true;
  } catch (error) {
    await rm(remuxPath, { force: true });
    logger.warn('Could not remux the upload; keeping it as uploaded', { file: parsed.base, was: layout, error });
    return false;
  }
}
