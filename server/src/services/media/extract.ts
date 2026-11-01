
import { spawn } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export type MediaProcessingErrorCode =
  | 'FFMPEG_NOT_FOUND'
  | 'FFPROBE_NOT_FOUND'
  | 'PROBE_FAILED'
  | 'EXTRACTION_FAILED';

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
        const installCommand =
          process.platform === 'win32'
            ? 'winget install Gyan.FFmpeg'
            : process.platform === 'darwin'
              ? 'brew install ffmpeg'
              : 'sudo apt install ffmpeg';

        reject(
          new MediaProcessingError(
            missingCode,
            `${command} was not found. Install FFmpeg using: ${installCommand}`,
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
