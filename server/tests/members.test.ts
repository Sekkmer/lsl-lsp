import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runPipeline, docFrom } from './testUtils';
import { loadDefs } from '../src/defs';

describe('vector/rotation members', () => {
	it('vector allows .x/.y/.z, rejects .s', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', 'common', 'lsl-defs.json'));
		const code = `
vector v;
float a = v.x;
float b = v.y;
float c = v.z;
float d = v.s; // invalid
`;
		const doc = docFrom(code, 'file:///proj/members_vec.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Unknown member ".s" for vector'))).toBe(true);
		expect(msgs.some(m => m.includes('v.x'))).toBe(false);
		expect(msgs.some(m => m.includes('v.y'))).toBe(false);
		expect(msgs.some(m => m.includes('v.z'))).toBe(false);
	});

	it('rotation allows .x/.y/.z/.s, rejects others', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', 'common', 'lsl-defs.json'));
		const code = `
rotation r;
float a = r.x;
float b = r.y;
float c = r.z;
float d = r.s;
float e = r.w; // invalid
`;
		const doc = docFrom(code, 'file:///proj/members_rot.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Unknown member ".w" for rotation'))).toBe(true);
		// Ensure no diagnostics for valid members
		expect(msgs.some(m => m.includes('Unknown member') && m.includes('".x"'))).toBe(false);
		expect(msgs.some(m => m.includes('Unknown member') && m.includes('".y"'))).toBe(false);
		expect(msgs.some(m => m.includes('Unknown member') && m.includes('".z"'))).toBe(false);
		expect(msgs.some(m => m.includes('Unknown member') && m.includes('".s"'))).toBe(false);
	});
});
