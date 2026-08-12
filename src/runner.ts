import { spawn } from 'node:child_process';
import type { CommandResult, RunnerResult, StackInfo } from './types.js';

export const MAX_OUTPUT_CHARS = 30_000;
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const keep = MAX_OUTPUT_CHARS - 100;
  return `[truncado] se omitieron ${text.length - keep} caracteres del principio\n` + text.slice(-keep);
}

export function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true });
    const chunks: string[] = [];
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: exitCode === 0, exitCode, output: truncate(chunks.join('')) });
    };

    const timer = setTimeout(() => {
      chunks.push(`\n[el comando excedió el timeout de ${timeoutMs}ms y fue interrumpido]\n`);
      child.kill('SIGKILL');
      finish(124);
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('error', (err) => {
      chunks.push(`\n[no se pudo ejecutar el comando: ${err.message}]\n`);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export async function runStack(stack: StackInfo, cwd: string): Promise<RunnerResult> {
  const result: RunnerResult = { install: null, build: null, test: null };

  if (stack.install) {
    result.install = await runCommand(stack.install, cwd);
    if (!result.install.ok) return result;
  }

  if (stack.build) {
    result.build = await runCommand(stack.build, cwd);
    if (!result.build.ok) return result;
  }

  if (stack.test) {
    result.test = await runCommand(stack.test, cwd);
  }

  return result;
}
