import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Keep at most this many characters of each stream (tail). */
  keep?: number;
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Run an external tool without a shell; resolves with exit code and captured output tails. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const keep = opts.keep ?? 64_000;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const child = spawn(cmd, args, { windowsHide: true, signal: opts.signal, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout = (stdout + d).slice(-keep);
      opts.onStdout?.(d);
    });
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-keep);
      opts.onStderr?.(d);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') reject(new CancelledError());
      else reject(err);
    });
    child.on('close', (code) => {
      if (opts.signal?.aborted) reject(new CancelledError());
      else resolve({ code, stdout, stderr });
    });
  });
}

/** Run and throw a readable error on a non-zero exit code. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`${cmdName(cmd)} завершился с кодом ${res.code}:\n${tail}`);
  }
  return res;
}

function cmdName(cmd: string): string {
  return cmd.split(/[\\/]/).pop() ?? cmd;
}
