/**
 * A tiny calculator.
 *
 * `divide` has a bug on purpose: it does not guard against a zero divisor,
 * so the demo fails with a stack trace that points at a real user file.
 */

export function add(a, b) {
  return a + b;
}

export function divide(a, b) {
  return a / b;
}

export function percentOf(total, part) {
  return divide(part, total) * 100;
}
