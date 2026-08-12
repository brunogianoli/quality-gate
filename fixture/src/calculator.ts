export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

export function porcentaje(parte: number, total: number): number {
  if (total === 0) throw new Error('total cannot be zero');
  return (parte / total) * 100;
}
