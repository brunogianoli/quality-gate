import { describe, it, expect } from 'vitest';
import { runCommand, runStack, MAX_OUTPUT_CHARS } from '../src/runner.js';

describe('runCommand', () => {
  it('captura stdout de un comando exitoso', async () => {
    const result = await runCommand('node -e "console.log(\'hola\')"', process.cwd());
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hola');
  });

  it('marca ok=false y captura stderr de un comando fallido', async () => {
    const result = await runCommand('node -e "console.error(\'boom\');process.exit(3)"', process.cwd());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('boom');
  });

  it('trunca salidas muy largas conservando el final', async () => {
    const script = `node -e "console.log('x'.repeat(${MAX_OUTPUT_CHARS + 5000}));console.log('THE_END')"`;
    const result = await runCommand(script, process.cwd());
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 200);
    expect(result.output).toContain('THE_END');
    expect(result.output).toContain('[truncado]');
  });

  it('falla por timeout sin colgarse', async () => {
    const result = await runCommand('node -e "setTimeout(()=>{},5000)"', process.cwd(), 300);
    expect(result.ok).toBe(false);
  });
});

describe('runStack', () => {
  it('no corre build ni test si install falla', async () => {
    const result = await runStack(
      { kind: 'node', install: 'node -e "process.exit(1)"', build: 'node -e "0"', test: 'node -e "0"' },
      process.cwd(),
    );
    expect(result.install?.ok).toBe(false);
    expect(result.build).toBeNull();
    expect(result.test).toBeNull();
  });

  it('no corre test si build falla', async () => {
    const result = await runStack(
      { kind: 'node', install: null, build: 'node -e "process.exit(1)"', test: 'node -e "0"' },
      process.cwd(),
    );
    expect(result.build?.ok).toBe(false);
    expect(result.test).toBeNull();
  });

  it('corre los tres pasos cuando todos pasan', async () => {
    const result = await runStack(
      { kind: 'node', install: 'node -e "0"', build: 'node -e "0"', test: 'node -e "0"' },
      process.cwd(),
    );
    expect(result.install?.ok).toBe(true);
    expect(result.build?.ok).toBe(true);
    expect(result.test?.ok).toBe(true);
  });
});
