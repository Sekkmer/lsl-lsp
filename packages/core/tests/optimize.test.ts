import { describe, expect, it } from 'vitest';
import { formatLslText, optimizeScript, parseScriptFromText, shrinkNameOptionsFromDefs } from '../src';

function optimize(code: string) {
	return optimizeScript(parseScriptFromText(code));
}

describe('optimizer plumbing', () => {
	it('emits stable compact LSL', () => {
		const first = optimize('integer x = 1;\nfoo(integer a) { return; }\ndefault { state_entry() { ; } }');
		const second = optimize(first.code);
		expect(first.code).toBe('integer x=1;foo(integer a){return;}default{state_entry(){}}');
		expect(first.stable).toBe(true);
		expect(second.code).toBe(first.code);
	});

	it('folds pure constant expressions', () => {
		const result = optimize('integer x = 1 + 2 * 3; vector v = <1 + 1, 2 * 2, 9 / 3>; default { state_entry() { integer y = (integer)"42"; } }');
		expect(result.code).toContain('integer x=7;');
		expect(result.code).toContain('vector v=<2.0,4.0,3.0>;');
		expect(result.code).toContain('integer y=42;');
	});

	it('removes constant if branches without evaluating calls away', () => {
		const result = optimize('default { state_entry() { if (1 + 1) llOwnerSay("a"); else llOwnerSay("b"); if (0) llOwnerSay("c"); } }');
		expect(result.code).toBe('default{state_entry(){llOwnerSay("a");}}');
	});

	it('does not fold string concatenation by default', () => {
		const result = optimize('string s() { return "a" + "b"; } string t() { return (string)1 + (string)2; } default { state_entry() {} }');
		expect(result.code).toContain('return "ab";');
		expect(result.code).toContain('return (string)1+(string)2;');
		expect(result.code).not.toContain('"12"');
	});

	it('does not fold expressions with runtime calls', () => {
		const result = optimize('default { state_entry() { integer x = llGetUnixTime() + 1; } }');
		expect(result.code).toContain('integer x=llGetUnixTime()+1;');
	});

	it('drops only same-type no-op casts', () => {
		const result = optimize([
			'integer f(integer i, float f, string s) {',
			'  integer a = (integer)i;',
			'  float b = (float)f;',
			'  key k = (key)s;',
			'  integer c = (integer)f;',
			'  return a + c;',
			'}',
			'default { state_entry() {} }',
		].join('\n'));
		expect(result.code).toContain('integer a=i;');
		expect(result.code).toContain('float b=f;');
		expect(result.code).toContain('key k=(key)s;');
		expect(result.code).toContain('integer c=(integer)f;');
	});

	it('can drop literal default initializers after constant global inlining', () => {
		const source = [
			'integer mutable = 0;',
			'integer zero = 0;',
			'float f = 0.0;',
			'string s = "";',
			'key k = "00000000-0000-0000-0000-000000000000";',
			'list l = [];',
			'vector v = <0.0, 0.0, 0.0>;',
			'rotation r = <0.0, 0.0, 0.0, 1.0>;',
			'default { state_entry() {',
			'  integer local = 0;',
			'  integer keep = 1;',
			'  mutable = zero;',
			'  llOwnerSay((string)mutable + (string)local + (string)keep);',
			'} }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			dropDefaultInitializers: true,
			inlineConstantGlobals: true,
		});
		expect(result.code).toBe('integer mutable;default{state_entry(){integer local;integer keep=1;mutable=0;llOwnerSay((string)mutable+(string)local+(string)keep);}}');
	});

	it('can inline immutable global constants for CLI optimization', () => {
		const source = [
			'integer channel = 7;',
			'string keyName = "as-data";',
			'integer mutable = 0;',
			'default { state_entry() { mutable = channel; llOwnerSay(keyName); } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), { inlineConstantGlobals: true });
		expect(result.code).toBe('integer mutable=0;default{state_entry(){mutable=7;llOwnerSay("as-data");}}');
	});

	it('inlines constant globals transitively before removing their declarations', () => {
		const source = [
			'string first = "a";',
			'string second = first;',
			'list menu = [second, "b"];',
			'default { state_entry() { llOwnerSay(llDumpList2String(menu, ",")); } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			builtinFunctionReturnTypes: new Map([['llDumpList2String', 'string']]),
			inlineConstantGlobals: true,
			listAdd: true,
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('llOwnerSay(llDumpList2String((list)"a"+"b",","));');
		expect(result.code).not.toContain('first');
		expect(result.code).not.toContain('second');
		expect(result.code).not.toContain('menu');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('keeps globals needed for legal vector member access', () => {
		const source = [
			'vector position = <1.0, 2.0, 3.0>;',
			'default { state_entry() { llOwnerSay((string)position.y); } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			inlineConstantGlobals: true,
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('vector _=<1.0,2.0,3.0>;');
		expect(result.code).toContain('_.y');
		expect(result.code).not.toContain('<1.0,2.0,3.0>.y');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('can rewrite non-nested list literals to list additions', () => {
		const source = [
			'list returnsList() { return []; }',
			'default { state_entry() {',
			'  list a = ["x", 1];',
			'  list b = [returnsList(), "x"];',
			'} }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			listAdd: true,
			builtinFunctionReturnTypes: new Map([['returnsList', 'list']]),
		});
		expect(result.code).toContain('list a=(list)"x"+1;');
		expect(result.code).toContain('list b=[returnsList(),"x"];');
	});

	it('preserves postfix increments when list literals become additions', () => {
		const source = [
			'default { state_entry() {',
			'  integer index = 0;',
			'  list path = ["content", index++];',
			'  llOwnerSay(llList2String(path, 1));',
			'} }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			builtinFunctionReturnTypes: new Map([['llList2String', 'string']]),
			listAdd: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('list A=(list)"content"+_++;');
		expect(result.code).not.toContain('++"content"');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('does not rewrite global list literals into invalid initializer expressions', () => {
		const source = [
			'list INTER = [1, 4,',
			'              3, 6,',
			'              8, 8,',
			'              15, 10,',
			'              -1, -1];',
			'default { state_entry() { list local = [1, 4, -1]; } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			listAdd: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('list _=[1,4,3,6,8,8,15,10,-1,-1];');
		expect(result.code).toContain('list A=(list)1+4+-1;');
		expect(result.code).not.toContain('list _=(list)1+4');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('rewrites list compound append to list addition without changing RHS grouping', () => {
		const source = 'default { state_entry() { integer x = 1; list y = []; y += [x, 2]; y += [3]; } }';
		const result = optimizeScript(parseScriptFromText(source), { listAdd: true });
		expect(result.code).toContain('y=y+x+2;');
		expect(result.code).toContain('y=y+3;');
		expect(result.code).not.toContain('y+=x+2;');
	});

	it('can fold supplied builtin constants', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { integer a = TRUE; integer b = STRING_TRIM; if (FALSE) llOwnerSay("bad"); } }'), {
			builtinConstants: new Map([
				['TRUE', { kind: 'value', type: 'integer', value: 1 }],
				['FALSE', { kind: 'value', type: 'integer', value: 0 }],
				['STRING_TRIM', { kind: 'value', type: 'integer', value: 3 }],
			]),
		});
		expect(result.code).toBe('default{state_entry(){integer a=1;integer b=3;}}');
	});

	it('can rewrite list length checks using Mono list truthiness', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { list items = []; integer n = llGetListLength(items); if (llGetListLength(items)) llOwnerSay("items"); } }'), {
			listAdd: true,
			builtinFunctionReturnTypes: new Map([['llGetListLength', 'integer']]),
		});
		expect(result.code).toContain('integer n=items!=[];');
		expect(result.code).toContain('if(items!=[])llOwnerSay("items");');
	});

	it('rewrites safe builtin list helpers', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  list items = ["a"];',
			'  string a = llDumpList2String(items, "");',
			'  string b = llDumpList2String(["x"], ",");',
			'  list c = llDeleteSubList(items, 0, -1);',
			'  list d = llListReplaceList(items, [], 0, -1);',
			'  llOwnerSay(a + b + (string)(c == []) + (string)(d == []));',
			'} }',
		].join('\n')), {
			builtinFunctionReturnTypes: new Map([
				['llDumpList2String', 'string'],
				['llDeleteSubList', 'list'],
				['llListReplaceList', 'list'],
			]),
		});
		expect(result.code).toContain('string a=(string)items;');
		expect(result.code).toContain('string b="x";');
		expect(result.code).toContain('list c=[];');
		expect(result.code).toContain('list d=[];');
	});

	it('uses sign shorthand only in boolean condition context', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { integer idx = llSubStringIndex("x", "y"); integer same = idx != -1; if (idx != -1) llOwnerSay("found"); if (-1 == idx) llOwnerSay("missing"); } }'), {
			builtinFunctionReturnTypes: new Map([['llSubStringIndex', 'integer']]),
		});
		expect(result.code).toContain('integer same=idx!=-1;');
		expect(result.code).toContain('if(~idx)llOwnerSay("found");');
		expect(result.code).toContain('if(!~idx)llOwnerSay("missing");');
	});

	it('can rewrite logical operators only when operands are boolean-valued', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer a = 1;',
			'  integer b = 2;',
			'  list items = [];',
			'  if ((a > 0) && (b < 3) || !(a == b)) llOwnerSay("bool");',
			'  if (a && b) llOwnerSay("raw");',
			'  if ((items != []) && (a > 0)) llOwnerSay("list");',
			'} }',
		].join('\n')), {
			bitwiseBooleanOps: true,
		});
		expect(result.code).toContain('if(a>0&b<3|!(a==b))llOwnerSay("bool");');
		expect(result.code).toContain('if(a&&b)llOwnerSay("raw");');
		expect(result.code).toContain('if(items!=[]&&a>0)llOwnerSay("list");');
	});

	it('emits nested cast operands with parentheses after boolean operator rewrites', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer A(string M0) {',
			'  return ((key)M0 != NULL_KEY) && ((string)((key)M0) == M0);',
			'}',
			'default { state_entry() { llOwnerSay((string)A(llGetScriptName())); } }',
		].join('\n')), {
			bitwiseBooleanOps: true,
			builtinConstants: new Map([['NULL_KEY', { kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000000' }]]),
			builtinFunctionReturnTypes: new Map([['llGetScriptName', 'string']]),
		});
		expect(result.code).toContain('(string)((key)M0)==M0');
		expect(result.code).not.toContain('(string)(key)M0');
		expect(parseScriptFromText(result.code).diagnostics.some(d => d.message.includes('Chained casts'))).toBe(false);
	});

	it('does not emit invalid chained casts when propagating locals', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer isValidUUID(string s) {',
			'  key k = (key)s;',
			'  return (k != NULL_KEY) && ((string)k == s);',
			'}',
			'default { state_entry() { llOwnerSay((string)isValidUUID(llGetScriptName())); } }',
		].join('\n')), {
			bitwiseBooleanOps: true,
			builtinConstants: new Map([['NULL_KEY', { kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000000' }]]),
			builtinFunctionReturnTypes: new Map([['llGetScriptName', 'string']]),
			dropDefaultInitializers: true,
			dropNoOpCasts: true,
			foldStringConcats: true,
			inlineConstantGlobals: true,
			inlineFunctions: true,
			integerPeepholes: true,
			listAdd: true,
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('(string)((key)');
		expect(result.code).not.toContain('(string)(key)');
		expect(parseScriptFromText(result.code).diagnostics.some(d => d.message.includes('Chained casts'))).toBe(false);
		const formatted = formatLslText(result.code);
		expect(formatted).toContain('(string)((key)');
		expect(formatted).not.toContain('(string)(key)');
		expect(parseScriptFromText(formatted).diagnostics).toHaveLength(0);
	});

	it('keeps optimized list-length loop headers valid after formatting', () => {
		const result = optimizeScript(parseScriptFromText([
			'string link(key id) { return (string)id; }',
			'default { state_entry() {',
			'  list close = [];',
			'  string txt = "Choose an avatar to add as owner, or enter an UUID:\\n";',
			'  integer count = llGetListLength(close);',
			'  list buttons = ["Back", " ", "UUID"];',
			'  integer i;',
			'  for (i = 0; i < count; i++) {',
			'    key agent = llList2Key(close, i);',
			'    txt += "\\n" + (string)i + " " + link(agent);',
			'    buttons += [(string)i];',
			'  }',
			'  for (i = count; i < 6; i++) buttons += [" "];',
			'} }',
		].join('\n')), {
			builtinFunctionReturnTypes: new Map([['llGetListLength', 'integer'], ['llList2Key', 'key']]),
			dropDefaultInitializers: true,
			foldStringConcats: true,
			inlineFunctions: true,
			integerPeepholes: true,
			listAdd: true,
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		const formatted = formatLslText(result.code);
		expect(formatted).toContain(' != []');
		expect(formatted).not.toContain('! = []');
		expect(parseScriptFromText(formatted).diagnostics).toHaveLength(0);
	});

	it('can apply integer-only peepholes for optimized output', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer a = llGetUnixTime();',
			'  integer b = a + 1;',
			'  integer c = a - 1;',
			'  a += 1;',
			'  a = a - 1;',
			'  float f = 1.5;',
			'  float g = f + 1;',
			'  for (; a != 7; a += 1) llOwnerSay("loop");',
			'  if (a == 8) llOwnerSay("eq"); else llOwnerSay("ne");',
			'  if ((string)a != "") llOwnerSay("string");',
			'} }',
		].join('\n')), {
			integerPeepholes: true,
			builtinFunctionReturnTypes: new Map([['llGetUnixTime', 'integer']]),
		});
		expect(result.code).toContain('integer b=-~a;');
		expect(result.code).toContain('integer c=~-a;');
		expect(result.code).toContain('++a;--a;');
		expect(result.code).toContain('float g=f+1;');
		expect(result.code).toContain('for(;a^7;++a)llOwnerSay("loop");');
		expect(result.code).toContain('if(a^8)llOwnerSay("ne");else llOwnerSay("eq");');
		expect(result.code).toContain('if((string)a!="")llOwnerSay("string");');
	});

	it('parenthesizes nested unary peepholes used as multiplicative operands', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer q = 1;',
			'  float c = 0.5;',
			'  float e = (q * 2 - 1) * 0.006 / c;',
			'} }',
		].join('\n')), {
			integerPeepholes: true,
		});
		expect(result.code).toContain('float e=(~-(q*2))*0.006/c;');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('does not inline locals into member access receivers', () => {
		const source = [
			'default { state_entry() {',
			'  list values = llGetObjectDetails(llGetOwner(), [OBJECT_POS]);',
			'  vector position = llList2Vector(values, 0);',
			'  float y = position.y;',
			'  llOwnerSay((string)y);',
			'} }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			builtinFunctionReturnTypes: new Map([['llGetObjectDetails', 'list'], ['llGetOwner', 'key'], ['llList2Vector', 'vector']]),
			inlineFunctions: true,
			listAdd: true,
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('vector A=llList2Vector');
		expect(result.code).toContain('A.y');
		expect(result.code).not.toContain(').y');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('folds runtime calls when the evaluator produces a concrete value', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { integer a = llOrd("a", 0); integer b = llOrd("ab", -1); integer c = llOrd(llGetScriptName(), 0); } }'), {
			builtinFunctionReturnTypes: new Map([
				['llGetScriptName', 'string'],
				['llOrd', 'integer'],
			]),
		});
		expect(result.code).toContain('integer a=97;');
		expect(result.code).toContain('integer b=98;');
		expect(result.code).toContain('integer c=llOrd(llGetScriptName(),0);');
	});

	it('folds concrete llList2 extraction calls but keeps unknown elements', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer i = llList2Integer(["0x10"], 0);',
			'  float f = llList2Float([2.5], 0);',
			'  string s = llList2String([<1,2,3>], 0);',
			'  key k = llList2Key([(key)"00000000-0000-0000-0000-000000000001"], 0);',
			'  vector v = llList2Vector([<1,2,3>], 0);',
			'  rotation r = llList2Rot([<1,2,3,4>], 0);',
			'  string vs = (string)llList2Vector([<1,2,3>], 0);',
			'  string rs = (string)llList2Rot([<1,2,3,4>], 0);',
			'  string runtime = llList2String([llGetScriptName()], 0);',
			'} }',
		].join('\n')), {
			builtinFunctionReturnTypes: new Map([
				['llList2Integer', 'integer'],
				['llList2Float', 'float'],
				['llList2String', 'string'],
				['llList2Key', 'key'],
				['llList2Vector', 'vector'],
				['llList2Rot', 'rotation'],
				['llGetScriptName', 'string'],
			]),
		});
		expect(result.code).toContain('integer i=16;');
		expect(result.code).toContain('float f=2.5;');
		expect(result.code).toContain('string s="<1.000000, 2.000000, 3.000000>";');
		expect(result.code).toContain('key k=(key)"00000000-0000-0000-0000-000000000001";');
		expect(result.code).toContain('vector v=<1.0,2.0,3.0>;');
		expect(result.code).toContain('rotation r=<1.0,2.0,3.0,4.0>;');
		expect(result.code).toContain('string vs="<1.00000, 2.00000, 3.00000>";');
		expect(result.code).toContain('string rs="<1.00000, 2.00000, 3.00000, 4.00000>";');
		expect(result.code).toContain('string runtime=llList2String([llGetScriptName()],0);');
	});

	it('folds user functions proven pure by their body', () => {
		const result = optimize([
			'integer addOne(integer value) { return value + 1; }',
			'integer fromBuiltin(string value) { return addOne(llOrd(value, 0)); }',
			'default { state_entry() { integer a = fromBuiltin("a"); } }',
		].join('\n'));
		expect(result.code).toContain('integer a=98;');
	});

	it('does not fold pure user calls when argument evaluation has side effects', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer constant(integer unused) { return 1; }',
			'default { state_entry() { integer a = constant(llListen(1, "", NULL_KEY, "")); } }',
		].join('\n')), {
			builtinConstants: new Map([['NULL_KEY', { kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000000' }]]),
			builtinFunctionReturnTypes: new Map([['llListen', 'integer']]),
		});
		expect(result.code).toContain('integer a=constant(llListen');
	});

	it('does not fold user functions through unknown loop control flow', () => {
		const result = optimize([
			'list names = [];',
			'integer findName(string value) {',
			'  value = llToLower(value);',
			'  integer index;',
			'  for (index = 0; index < (names != []); index += 2) {',
			'    if (llList2String(names, index) == value) return index;',
			'  }',
			'  return -1;',
			'}',
			'default { state_entry() { string name = llGetScriptName(); integer index = findName(name); llOwnerSay((string)index); } }',
		].join('\n'));
		expect(result.code).toContain('integer index=findName(name);');
		expect(result.code).not.toContain('integer index=-1;');
	});

	it('does not fold user functions with side-effect calls', () => {
		const result = optimize([
			'integer noisy(integer value) { llOwnerSay((string)value); return value + 1; }',
			'default { state_entry() { integer a = noisy(1); } }',
		].join('\n'));
		expect(result.code).toContain('integer a=noisy(1);');
	});

	it('can inline single-use functions when doing so shrinks emitted code', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer addOne(integer value) { return value + 1; }',
			'default { state_entry() { integer a = addOne(3); llOwnerSay((string)a); } }',
		].join('\n')), {
			inlineFunctions: true,
			removeUnusedFunctions: true,
		});
		expect(result.code).toBe('default{state_entry(){llOwnerSay("4");}}');
	});

	it('can inline single-use impure expression functions when the measured Mono cost drops', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer unixTime() { return llGetUnixTime(); }',
			'default { state_entry() { integer a = unixTime(); } }',
		].join('\n')), {
			inlineFunctions: true,
			removeUnusedFunctions: true,
		});
		expect(result.code).toBe('default{state_entry(){integer a=llGetUnixTime();}}');
	});

	it('can inline statement functions while preserving side-effect argument evaluation', () => {
		const result = optimizeScript(parseScriptFromText([
			'tell(string value, integer noisy) {',
			'  if (value == "") return;',
			'  llOwnerSay(value);',
			'}',
			'default { state_entry() { tell("ok", llListen(1, "", NULL_KEY, "")); } }',
		].join('\n')), {
			inlineFunctions: true,
			removeUnusedFunctions: true,
			builtinConstants: new Map([['NULL_KEY', { kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000000' }]]),
			builtinFunctionReturnTypes: new Map([['llListen', 'integer']]),
		});
		expect(result.code).not.toContain('tell(string value,integer noisy)');
		expect(result.code).toContain('integer noisy=llListen');
		expect(result.code).toContain('llOwnerSay("ok");');
	});

	it('inlines single-use expression functions when the measured Mono cost drops', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer addOne(integer value) { return value + 1; }',
			'default { state_entry() { } touch_start(integer count) { llOwnerSay((string)addOne(count)); } }',
		].join('\n')), {
			inlineFunctions: true,
			removeUnusedFunctions: true,
		});
		expect(result.code).toBe('default{touch_start(integer count){llOwnerSay((string)(count+1));}}');
	});

	it('inlines multi-use expression functions when the measured Mono cost drops', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer addOne(integer value) { return value + 1; }',
			'default { state_entry() {',
			'  integer count = llGetUnixTime();',
			'  integer total = addOne(count) + addOne(count + 1) + addOne(count + 2);',
			'  llOwnerSay((string)total);',
			'} }',
		].join('\n')), {
			inlineFunctions: true,
			integerPeepholes: true,
			removeUnusedFunctions: true,
		});
		expect(result.code).not.toContain('addOne');
		expect(result.code).toContain('3*count+6');
	});

	it('does not collapse repeated calls into arithmetic terms', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer total = llGetUnixTime() + llGetUnixTime() + 6;',
			'  llOwnerSay((string)total);',
			'} }',
		].join('\n')), {
			integerPeepholes: true,
		});
		expect(result.code).toContain('llGetUnixTime()+llGetUnixTime()+6');
		expect(result.code).not.toContain('2*llGetUnixTime()+6');
	});

	it('does not inline when parameter substitution would duplicate an argument', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer doubleValue(integer value) { return value + value; }',
			'default { state_entry() { integer a = doubleValue(llGetUnixTime()); } }',
		].join('\n')), {
			inlineFunctions: true,
			removeUnusedFunctions: true,
		});
		expect(result.code).toContain('integer doubleValue(integer value){return value+value;}');
		expect(result.code).toContain('integer a=doubleValue(llGetUnixTime());');
	});

	it('removes unreachable user functions when requested', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer unused() { return 1; }',
			'integer used() { return llGetUnixTime(); }',
			'default { state_entry() { integer a = used(); } }',
		].join('\n')), {
			removeUnusedFunctions: true,
		});
		expect(result.code).not.toContain('unused');
		expect(result.code).toContain('integer used(){return llGetUnixTime();}');
	});

	it('removes unused user-function parameters when dropped arguments are safe', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer add(integer a, string unused, integer b) { return a + b; }',
			'integer keep(integer a, integer noisy) { return a; }',
			'default { state_entry() {',
			'  integer x = llGetUnixTime();',
			'  integer y = llGetUnixTime();',
			'  llOwnerSay((string)add(x, "ignored", 2));',
			'  llOwnerSay((string)keep(y, llListen(1, "", NULL_KEY, "")));',
			'} }',
		].join('\n')), {
			removeUnusedFunctions: true,
			builtinConstants: new Map([['NULL_KEY', { kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000000' }]]),
			builtinFunctionReturnTypes: new Map([['llGetUnixTime', 'integer'], ['llListen', 'integer']]),
		});
		expect(result.code).toContain('integer add(integer a,integer b){return a+b;}');
		expect(result.code).toContain('add(x,2)');
		expect(result.code).toContain('integer keep(integer a,integer noisy){return a;}');
		expect(result.code).toContain('keep(y,llListen');
	});

	it('removes unused globals and local declarations when initializers have no side effects', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer unusedGlobal = 1 + 2;',
			'integer keptGlobal = 3;',
			'default { state_entry() { integer unusedLocal = 4; integer keptLocal = keptGlobal; llOwnerSay((string)keptLocal); } }',
		].join('\n')), {
			removeUnusedFunctions: true,
		});
		expect(result.code).toBe('integer keptGlobal=3;default{state_entry(){llOwnerSay((string)keptGlobal);}}');
	});

	it('keeps unused declarations only when their initializers have side effects', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { integer unusedLocal = llOrd("x", 0); integer noisy = llListen(1, "", NULL_KEY, ""); } }'), {
			removeUnusedFunctions: true,
			builtinConstants: new Map([['NULL_KEY', { kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000000' }]]),
			builtinFunctionReturnTypes: new Map([
				['llOrd', 'integer'],
				['llListen', 'integer'],
			]),
		});
		expect(result.code).not.toContain('unusedLocal');
		expect(result.code).toContain('integer noisy=llListen');
	});

	it('removes empty events, no-op functions, and pure expression statements', () => {
		const result = optimizeScript(parseScriptFromText([
			'empty() {}',
			'integer pureValue(integer value) { return value + 1; }',
			'default {',
			'  touch_start(integer n) {}',
			'  state_entry() { empty(); pureValue(1); if (1) {} while (0) {} for (; 0; ) {} llOwnerSay("kept"); }',
			'}',
		].join('\n')), {
			removeUnusedFunctions: true,
		});
		expect(result.code).toBe('default{state_entry(){llOwnerSay("kept");}}');
	});

	it('propagates single-use local declarations only when emitted code shrinks', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  string value = llStringTrim(" x ", STRING_TRIM);',
			'  llOwnerSay(value);',
			'} }',
		].join('\n')), {
			removeUnusedFunctions: true,
			builtinConstants: new Map([['STRING_TRIM', { kind: 'value', type: 'integer', value: 3 }]]),
		});
		expect(result.code).toBe('default{state_entry(){llOwnerSay("x");}}');
	});

	it('propagates multi-use local declarations only when emitted code shrinks', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer one = 1;',
			'  integer longName = llGetUnixTime();',
			'  llOwnerSay((string)(one + one));',
			'  llOwnerSay((string)(longName + longName));',
			'} }',
		].join('\n')), {
			removeUnusedFunctions: true,
			builtinFunctionReturnTypes: new Map([['llGetUnixTime', 'integer']]),
		});
		expect(result.code).toContain('llOwnerSay("2");');
		expect(result.code).not.toContain('integer one=1;');
		expect(result.code).toContain('integer longName=llGetUnixTime();');
	});

	it('can remove a multi-use pure-call local to reduce Mono local pressure', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer pureValue(integer value) { return value + 1; }',
			'default { state_entry() {',
			'  integer value = llGetUnixTime();',
			'  integer cached = pureValue(value);',
			'  llOwnerSay((string)cached);',
			'  llOwnerSay((string)cached);',
			'} }',
		].join('\n')), {
			removeUnusedFunctions: true,
			builtinFunctionReturnTypes: new Map([['llGetUnixTime', 'integer']]),
		});
		expect(result.code).not.toContain('integer cached=');
		expect(result.code).toContain('llOwnerSay((string)pureValue(value));llOwnerSay((string)pureValue(value));');
	});

	it('does not propagate locals across dependency mutations', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  integer source = llGetUnixTime();',
			'  integer value = source + 1;',
			'  source = 4;',
			'  llOwnerSay((string)value);',
			'} }',
		].join('\n')), {
			removeUnusedFunctions: true,
		});
		expect(result.code).toContain('integer value=source+1;');
		expect(result.code).toContain('source=4;');
	});

	it('does not remove local declarations that still have nested references', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() {',
			'  list entries = llParseStringKeepNulls(llGetScriptName(), [","], []);',
			'  integer index;',
			'  for (index = 0; index < (entries != []); ++index) {',
			'    llOwnerSay(llList2String(entries, index));',
			'  }',
			'} }',
		].join('\n')), {
			removeUnusedFunctions: true,
			listAdd: true,
			builtinFunctionReturnTypes: new Map([
				['llGetScriptName', 'string'],
				['llParseStringKeepNulls', 'list'],
				['llList2String', 'string'],
			]),
		});
		expect(result.code).toContain('list entries=llParseStringKeepNulls');
		expect(result.code).toContain('llList2String(entries,index)');
	});

	it('removes immediate jump-label pairs, unreferenced labels, and trailing bare returns', () => {
		const result = optimizeScript(parseScriptFromText([
			'cleanup() { jump done; @done; return; }',
			'default { state_entry() { @unused; jump kept; @kept; return; } }',
		].join('\n')), {
			removeUnusedFunctions: true,
		});
		expect(result.code).toBe('default{state_entry(){}}');
	});

	it('keeps one empty event when removing all events would leave invalid state syntax', () => {
		const result = optimizeScript(parseScriptFromText([
			'default { state_entry() { state parking; } }',
			'state parking { state_entry() { } }',
		].join('\n')), {
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		expect(result.code).toBe('default{state_entry(){state _;}}state _{state_entry(){}}');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('preserves non-associative expression shape when emitting', () => {
		const result = optimize('integer f(integer a, integer b, integer c) { return a - (b - c); } default { state_entry() {} }');
		expect(result.code).toContain('return a-(b-c);');
	});

	it('keeps unary expressions parenthesized after casts when SL syntax needs it', () => {
		const result = optimize('list f(integer value) { return (list)(!!value); } default { state_entry() {} }');
		expect(result.code).toContain('return (list)(!!value);');
	});

	it('keeps adjacent unary minus operators from emitting as decrement', () => {
		const result = optimizeScript(parseScriptFromText([
			'integer channel(string value) { return -llAbs((integer)("0x" + llGetSubString(value, 30, -1))); }',
			'default { state_entry() { } touch_start(integer count) {',
			'  string id = llGetScriptName();',
			'  integer next = -channel(id);',
			'  llOwnerSay((string)next);',
			'} }',
		].join('\n')), {
			builtinFunctionReturnTypes: new Map([['llAbs', 'integer'], ['llGetScriptName', 'string'], ['llGetSubString', 'string']]),
			foldStringConcats: true,
			inlineFunctions: true,
			removeUnusedFunctions: true,
			shrinkNames: true,
		});
		expect(result.code).toContain('-(-llAbs(');
		expect(result.code).not.toContain('--llAbs');
		expect(parseScriptFromText(result.code).diagnostics).toHaveLength(0);
	});

	it('does not grow escaped strings over repeated optimization', () => {
		const first = optimize('string sentinel() { return "\\\\\\\\n"; } default { state_entry() {} }');
		const second = optimize(first.code);
		expect(first.code).toBe(second.code);
		expect(first.stable).toBe(true);
	});

	it('can shrink user-defined names without touching builtins or events', () => {
		const source = [
			'integer globalValue = 1;',
			'integer addValue(integer inputValue) { integer localValue = inputValue + globalValue; return localValue; }',
			'default { state_entry() { llOwnerSay((string)addValue(globalValue)); } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), { shrinkNames: true });
		expect(result.code).toBe('integer A=1;integer _(integer B){integer C=B+A;return C;}default{state_entry(){llOwnerSay((string)_(A));}}');
		const second = optimizeScript(parseScriptFromText(result.code), { shrinkNames: true });
		expect(second.code).toBe(result.code);
		expect(result.stable).toBe(true);
	});

	it('renames non-default states before functions and globals', () => {
		const source = [
			'integer globalValue = 1;',
			'goToWork() { state workingState; }',
			'default { state_entry() { goToWork(); } }',
			'state workingState { state_entry() { llOwnerSay((string)globalValue); state default; } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), { shrinkNames: true });
		expect(result.code).toBe('integer B=1;A(){state _;}default{state_entry(){A();}}state _{state_entry(){llOwnerSay((string)B);state default;}}');
	});

	it('reserves definition names only where LSL needs them reserved', () => {
		const source = [
			'integer userGlobal = 1;',
			'integer userFunc(integer value) { integer localValue = value + userGlobal; return localValue; }',
			'default { state_entry() { llOwnerSay((string)userFunc(userGlobal)); } }',
		].join('\n');
		const result = optimizeScript(parseScriptFromText(source), {
			shrinkNames: true,
			shrinkNameOptions: shrinkNameOptionsFromDefs({
				consts: new Map([['A', {}]]),
				funcs: new Map([['_', {}], ['B', {}]]),
				events: new Map([['C', {}]]),
			}),
		});
		expect(result.code).toBe('integer E=1;integer D(integer _){integer B=_+E;return B;}default{state_entry(){llOwnerSay((string)D(E));}}');
	});

	it('does not rewrite builtin call names when a local reuses the same identifier', () => {
		const source = 'string f(string input) { string llToLower = input; return llToLower(llToLower); } default { state_entry() {} }';
		const result = optimizeScript(parseScriptFromText(source), { shrinkNames: true });
		expect(result.code).toContain('return llToLower(');
		expect(result.code).not.toContain('return A(');
	});
});
