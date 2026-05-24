import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { loadDefs } from '../src/defs';
import { NULL_KEY_VALUE } from '../src/ast/key';
import { evalExpr } from '../src/ast/eval';
import type { Expr } from '../src/ast/types';
import { join } from 'node:path';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('string literal UUID to key', () => {
	it('allows UUID-like string literal for key parameter without warning', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo("${UUID}");
	}
}
`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const warning = analysis.diagnostics.find(d => d.code === 'LSL013');
		expect(warning).toBeFalsy();
	});

	it('allows non-UUID string literal for key parameter but still warns', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo("not-a-uuid");
	}
}
`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const warnings = analysis.diagnostics.filter(d => d.code === 'LSL013');
		expect(warnings.length).toBeGreaterThan(0);
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('allows exact empty string literal for key parameter without warning', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo("");
	}
}
`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const warning = analysis.diagnostics.find(d => d.code === 'LSL013');
		expect(warning).toBeFalsy();
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('allows UUID-valued builtin string constants for key parameter without warning', async () => {
		const defs = await loadDefs(join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo(NULL_KEY);
		foo(TEXTURE_BLANK);
	}
}
`;
		const doc = docFrom(code, 'file:///uuid-valued-const-key-param.lsl');
		const { analysis } = runPipeline(doc, defs);
		const warning = analysis.diagnostics.find(d => d.code === 'LSL013');
		expect(warning).toBeFalsy();
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('still warns for non-builtin string identifiers passed to key parameter', async () => {
		const defs = await loadDefs(join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
		const code = `
string notKey = "not-a-uuid";
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo(notKey);
	}
}
`;
		const doc = docFrom(code, 'file:///non-builtin-string-key-param.lsl');
		const { analysis } = runPipeline(doc, defs);
		const warnings = analysis.diagnostics.filter(d => d.code === 'LSL013');
		expect(warnings.length).toBeGreaterThan(0);
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('still warns for whitespace-only string literal passed to key parameter', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo(" ");
	}
}
`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const warnings = analysis.diagnostics.filter(d => d.code === 'LSL013');
		expect(warnings.length).toBeGreaterThan(0);
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('allows empty string for llMessageLinked ID argument without warning', async () => {
		const defs = await loadDefs(join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
		const code = `
default {
	state_entry() {
		llMessageLinked(LINK_SET, 0, "ping", "");
	}
}
`;
		const doc = docFrom(code, 'file:///ll-message-linked-empty-key.lsl');
		const { analysis } = runPipeline(doc, defs);
		const warning = analysis.diagnostics.find(d => d.code === 'LSL013');
		expect(warning).toBeFalsy();
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('evaluates empty string cast to key as NULL_KEY', () => {
		const span = { start: 0, end: 0 };
		const expr: Expr = {
			kind: 'Cast',
			type: 'key',
			argument: { kind: 'StringLiteral', value: '', span },
			span,
		};
		expect(evalExpr(expr)).toEqual({ kind: 'value', type: 'key', value: NULL_KEY_VALUE });
	});
});
