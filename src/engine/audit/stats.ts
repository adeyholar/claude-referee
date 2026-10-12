// The two statistics the audit study registered: a one-sided Fisher exact test on a 2x2 table and the AUROC of a score against a binary label.
// Plain code, no dependencies; the table is small, so log-factorials are summed directly.

const logFactorial = (n: number): number => {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
};

// P(X >= a) for the table [[a, b], [c, d]] with fixed margins: the chance of at least a pushbacks in the first row if pushback were unrelated to the row.
export function fisherOneSided(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  if (n === 0 || row1 === 0 || col1 === 0) return 1;
  const logChoose = (x: number, y: number): number => logFactorial(x) - logFactorial(y) - logFactorial(x - y);
  let p = 0;
  for (let k = a; k <= Math.min(row1, col1); k++) {
    if (n - col1 < row1 - k) continue;
    p += Math.exp(logChoose(col1, k) + logChoose(n - col1, row1 - k) - logChoose(n, row1));
  }
  return Math.min(1, p);
}

// Probability that a random positive scores above a random negative; ties count half. Null when either group is empty.
export function auroc(positive: readonly number[], negative: readonly number[]): number | null {
  if (positive.length === 0 || negative.length === 0) return null;
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

export const rate = (hits: number, n: number): number | null => (n === 0 ? null : hits / n);
