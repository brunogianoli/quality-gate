import { describe, it, expect } from 'vitest';
import { CASES } from './golden/cases.js';
import { selectAuditors } from '../src/analyzer.js';
import { decide, loadPolicy } from '../src/policy.js';
import type { Policy } from '../src/types.js';

let policy: Policy;

describe('golden set', () => {
  it.each(CASES)('$name', async (c) => {
    policy ??= await loadPolicy(process.cwd());

    const testsFailed = Boolean(c.runner.test && !c.runner.test.ok);

    // `expectedAuditors` es siempre el resultado final esperado, ya con el
    // corte parcial aplicado donde corresponde. El test no recalcula nada.
    const selected = selectAuditors(policy, c.files, {
      criteriaAvailable: c.criteriaAvailable,
      testsFailed,
    });

    expect(selected.sort()).toEqual([...c.expectedAuditors].sort());
    expect(decide(policy, c.runner, c.findings).verdict).toBe(c.expectedVerdict);
  });
});
