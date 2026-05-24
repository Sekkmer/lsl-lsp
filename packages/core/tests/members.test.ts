import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runPipeline, docFrom } from './testUtils';
import { loadDefs } from '../src/defs';

describe('vector/rotation members', () => {
	it('vector allows .x/.y/.z, rejects .s', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
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
		const defs = await loadDefs(path.join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
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

	it('only allows component access on variables/components, not values or constants', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
		const code = `
vector makeVector() { return <1,2,3>; }
default {
	state_entry() {
		vector v = <1,2,3>;
		float ok = v.x;
		float callBase = makeVector().x;
		float literalBase = <1,2,3>.x;
		float constantBase = ZERO_VECTOR.x;
	}
}
`;
		const doc = docFrom(code, 'file:///proj/members_value_base.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const memberBaseErrors = analysis.diagnostics.filter(d => d.message.includes('Member access is only allowed on vector/rotation variables or components'));
		expect(memberBaseErrors.length).toBe(3);
		expect(analysis.diagnostics.some(d => d.message.includes('Unknown member') && d.message.includes('ok'))).toBe(false);
	});
});
