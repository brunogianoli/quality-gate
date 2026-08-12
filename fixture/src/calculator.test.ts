import { describe, it, expect } from 'vitest';
import { add, divide } from './calculator.js';

describe('calculator', () => {
  it('suma', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('divide', () => {
    expect(divide(10, 2)).toBe(5);
  });

  it('rechaza la división por cero', () => {
    expect(() => divide(1, 0)).toThrow('division by zero');
  });
});
