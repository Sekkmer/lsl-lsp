import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Micro-tests to lock operator precedence and edge cases in #if/#elif evaluator
// Covers: precedence, parentheses, division, modulus, unary minus, chained &&/||, and mixed comparisons.

describe('#if expression precedence and edges', () => {
	it('multiplication before addition', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
  #if 1 + 2 * 3 == 7
  llSay(0, "OK");
  #else
  llSay(0, "BAD");
  #endif
  }
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		const ok = tokens.some(t => t.kind === 'str' && t.value.includes('OK'));
		const bad = tokens.some(t => t.kind === 'str' && t.value.includes('BAD'));
		expect(ok).toBe(true);
		expect(bad).toBe(false);
	});

	it('parentheses override precedence', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
  #if (1 + 2) * 3 == 9
  llSay(0, "OK");
  #else
  llSay(0, "BAD");
  #endif
  }
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('OK'))).toBe(true);
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('BAD'))).toBe(false);
	});

	it('division and modulus', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
  // 7 / 3 => 2 (integer), 7 % 3 => 1
  #if 7 / 3 == 2 && 7 % 3 == 1
  llSay(0, "OK");
  #else
  llSay(0, "BAD");
  #endif
  }
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('OK'))).toBe(true);
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('BAD'))).toBe(false);
	});

	it('unary minus binds to primary', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
  #if -1 + 2 == 1 && -(1 + 2) == -3
  llSay(0, "OK");
  #else
  llSay(0, "BAD");
  #endif
  }
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('OK'))).toBe(true);
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('BAD'))).toBe(false);
	});

	it('chained logical AND/OR short-circuit selection', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
  #if 0 && (1/0) || 1 && 0 || 1
  llSay(0, "OK");
  #else
  llSay(0, "BAD");
  #endif
  }
}
`);
		// Note: evaluator should short-circuit, not actually compute 1/0.
		const { tokens } = runPipeline(doc, defs, {});
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('OK'))).toBe(true);
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('BAD'))).toBe(false);
	});

	it('relational/equality mix with precedence', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
  #if 1 + 2 > 2 && 3 * 2 >= 6 && 4 - 1 <= 3 && 5 == 5 && 6 != 7
  llSay(0, "OK");
  #else
  llSay(0, "BAD");
  #endif
  }
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('OK'))).toBe(true);
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('BAD'))).toBe(false);
	});
});
