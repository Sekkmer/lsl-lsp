import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { parseScriptFromText } from '../src/ast/parser';
import { inferExprTypeFromAst } from '../src/ast/infer';
import type { SimpleType } from '../src/ast/infer';

const defsPath = path.join(__dirname, '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

describe('operator/type checks', () => {
	it('division/modulus by zero', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a = 4 / 0;
integer b = 4 % 0;
`;
		const doc = docFrom(code, 'file:///ops1.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Division by zero'))).toBe(true);
		expect(msgs.some(m => m.includes('Modulus by zero'))).toBe(true);
	});

	it('modulus types: only integer%integer or vector%vector', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a;
float b;
vector v;
vector w;
default { state_entry() {
	a = a % b; // bad
	v = v % w; // ok
} }
`;
		const doc = docFrom(code, 'file:///ops2.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator % expects integer%integer or vector%vector'))).toBe(true);
	});

	it('bitwise and shifts require integer', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
float f;
integer i;
integer a = i & 3; // ok
integer b = f & 3; // bad
integer c = i << 1; // ok
integer d = f >> 1; // bad
`;
		const doc = docFrom(code, 'file:///ops3.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.filter(m => m.includes('expects integer operands')).length).toBeGreaterThanOrEqual(2);
	});

	it('does not flag integer shifts inside parentheses and bitwise or', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer XorValue(string input) {
	string h8 = llGetSubString(llSHA256String(input), 0, 7);
	integer i; integer v = 0;
	for (i = 0; i < 8; ++i) {
		string ch = llToLower(llGetSubString(h8, i, i));
		integer n = llSubStringIndex("0123456789abcdef", ch);
		if (n < 0) return 0;
		v = (v << 4) | n;
	}
	return v;
}
`;
		const doc = docFrom(code, 'file:///ops4.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.some(m => m.includes('expects integer operands') && m.includes('LSL011'))).toBe(false);
	});

	it('addition combos: list ok, string ok, numeric ok; mismatch flagged', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
list L = [] + [1]; // ok
list A = [] + "x"; // scalar append: ok
list B = [] + ["x"]; // explicit concat: ok
string s = "a" + "b"; // ok
string si = "a" + 1; // bad
string is = 1 + "a"; // bad
float f = 1 + 2.0; // ok
vector v = <1,2,3> + <4,5,6>; // ok
integer bad = <1,2,3> + 1; // bad
`;
		const doc = docFrom(code, 'file:///ops4.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		expect(analysis.diagnostics.some(d => d.message.includes('appends'))).toBe(false);
		const typeErrors = analysis.diagnostics.filter(d => d.message.includes('Operator + type mismatch'));
		expect(typeErrors.some(d => d.message.includes('string + integer') && d.severity === DiagnosticSeverity.Error)).toBe(true);
		expect(typeErrors.some(d => d.message.includes('integer + string') && d.severity === DiagnosticSeverity.Error)).toBe(true);
		expect(typeErrors.some(d => d.message.includes('vector + integer') && d.severity === DiagnosticSeverity.Error)).toBe(true);
	});

	it('casts in addition resolve to string correctly', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
string header = "hdr";
integer listCount = 3;
string m1 = (string)listCount + "x"; // ok
string m2 = "a" + (string)listCount; // ok
string m3 = header + " (" + (string)listCount + "):"; // ok
`;
		const doc = docFrom(code, 'file:///ops_casts.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator + type mismatch'))).toBe(false);
	});

	it('allows cast of parenthesized postfix in string concat', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
	string name = "John";
	integer index = 0;
	name = (string)(index++) + " " + name; // should be ok
	}
}
`;
		const doc = docFrom(code, 'file:///ops_cast_postfix.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator + type mismatch'))).toBe(false);
	});

	it('doesn\'t flag call-result + string concat', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
string PrintPermission(integer perm) { return ""; }
default {
	state_entry() {
	integer c_Perm_Access = 0;
	string msg = "";
	msg += "Access: " + PrintPermission(c_Perm_Access) + "\n"; // ok
	}
}
`;
		const doc = docFrom(code, 'file:///ops_call_concat.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator + type mismatch'))).toBe(false);
	});

	it('vector/rotation SL-proven arithmetic combinations', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		vector v = <1,2,3>;
		float s = 2.0;
		rotation r = <0,0,0,1>;
		vector a = v * s; // scale: ok
		vector b = s * v; // commutative scale: ok
		vector c = v * r; // rotate: ok
		vector d = v / s; // scale: ok
		vector e = v / r; // inverse rotate: ok
		rotation f = r + r; // component add: ok
		rotation g = r - r; // component subtract: ok
		vector bad1 = r * v; // bad: order matters
		rotation bad2 = r / s; // bad
		rotation bad3 = r * s; // bad
		rotation bad4 = s * r; // bad
	}
}
`;
		const doc = docFrom(code, 'file:///ops_vec_mul.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.severity}`);
		expect(msgs.some(m => m.includes('vector * rotation'))).toBe(false);
		expect(msgs.some(m => m.includes('vector / rotation'))).toBe(false);
		expect(msgs.some(m => m.includes('rotation * vector') && m.includes(String(DiagnosticSeverity.Error)))).toBe(true);
		expect(msgs.some(m => m.includes('rotation / float') && m.includes(String(DiagnosticSeverity.Error)))).toBe(true);
		expect(msgs.some(m => m.includes('rotation * float') && m.includes(String(DiagnosticSeverity.Error)))).toBe(true);
		expect(msgs.some(m => m.includes('float * rotation') && m.includes(String(DiagnosticSeverity.Error)))).toBe(true);
	});

	it('allows rotation multiplication and compound assignment', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		rotation r1 = <0,0,0,1>;
		rotation r2 = <0,0,0,1>;
		rotation r3 = r1 * r2;
		r1 *= r2;
	}
}
`;
		const doc = docFrom(code, 'file:///ops_rot_mul.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator * type mismatch'))).toBe(false);
	});

	it('rejects string bitwise and string increment as SL compile errors', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		integer x = "1" | "2";
		string s = "1";
		s++;
	}
}
`;
		const doc = docFrom(code, 'file:///ops_string_bad.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.severity}`);
		expect(msgs.some(m => m.includes('Operator | expects integer operands') && m.includes(String(DiagnosticSeverity.Error)))).toBe(true);
		expect(msgs.some(m => m.includes('Operator ++ expects an integer variable') && m.includes(String(DiagnosticSeverity.Error)))).toBe(true);
	});

	it('infers known result types for SL-proven operator combinations', () => {
		const script = parseScriptFromText(`
list listAppend = [] + "x";
string stringConcat = "a" + "b";
vector vectorDivScalar = <2,4,6> / 2.0;
vector vectorDivRotation = <1,2,3> / <0,0,0,1>;
vector vectorModVector = <1,0,0> % <0,1,0>;
rotation rotationSub = <2,4,6,8> - <1,1,1,1>;
vector vectorTimesRotation = <1,2,3> * <0,0,0,1>;
rotation rotationTimesRotation = <0,0,0,1> * <0,0,0,1>;
string stringInt = "a" + 1;
rotation rotationDivScalar = <2,4,6,8> / 2.0;
`);
		const globals = new Map<string, SimpleType>();
		const inferGlobal = (name: string) => inferExprTypeFromAst(script.globals.get(name)?.initializer ?? null, globals);
		expect(inferGlobal('listAppend')).toBe('list');
		expect(inferGlobal('stringConcat')).toBe('string');
		expect(inferGlobal('vectorDivScalar')).toBe('vector');
		expect(inferGlobal('vectorDivRotation')).toBe('vector');
		expect(inferGlobal('vectorModVector')).toBe('vector');
		expect(inferGlobal('rotationSub')).toBe('rotation');
		expect(inferGlobal('vectorTimesRotation')).toBe('vector');
		expect(inferGlobal('rotationTimesRotation')).toBe('rotation');
		expect(inferGlobal('stringInt')).toBe('any');
		expect(inferGlobal('rotationDivScalar')).toBe('any');
	});
});
