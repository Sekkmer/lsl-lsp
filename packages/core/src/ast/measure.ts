import { emitScript } from './emit';
import type { Event, Expr, Function as FnNode, GlobalVar, Script, State, Stmt, Type } from './types';
import { AssertNever } from '../utils';

export interface AstMeasureOptions {
	monoMemoryLimit?: number;
	monoBaselineUsed?: number;
	sourceText?: string;
}

export interface AstMeasureCounts {
	globals: number;
	functions: number;
	states: number;
	nonDefaultStates: number;
	events: number;
	parameters: number;
	locals: number;
	statements: number;
	expressions: number;
	calls: number;
	builtinCalls: number;
	userValueCalls: number;
	ordinaryUserValueCalls: number;
	userVoidCalls: number;
	parameterizedEventUserValueCalls: number;
	parameterizedEventCallRuntimeBytes: number;
	listLiterals: number;
	listCasts: number;
	listElements: number;
	listRuntimeBytes: number;
	globalListRuntimeBytes: number;
	localListRuntimeBytes: number;
	localListLiteralRuntimeBytes: number;
	localListCastRuntimeBytes: number;
	castRuntimeBytes: number;
	globalCastRuntimeBytes: number;
	localCastRuntimeBytes: number;
	vectorLiterals: number;
	rotationLiterals: number;
	stringLiterals: number;
	stringLiteralCharacters: number;
	identifierReferences: number;
	identifierReferenceCharacters: number;
	declaredNameCharacters: number;
	labels: number;
	stateChanges: number;
}

export interface AstMeasureCostBuckets {
	baseline: number;
	compiledBody: number;
	declarations: number;
	containers: number;
	strings: number;
	controlFlow: number;
	calls: number;
	symbols: number;
}

export interface AstMeasureResult {
	monoMemoryLimit: number;
	estimatedMonoUsedMemory: number;
	estimatedMonoFreeMemory: number;
	compactCharacters: number;
	sourceCharacters?: number;
	counts: AstMeasureCounts;
	cost: AstMeasureCostBuckets;
	notes: string[];
}

const DEFAULT_MONO_LIMIT = 65536;
const DEFAULT_BASELINE_USED = 3884;

export function measureAst(script: Script, options: AstMeasureOptions = {}): AstMeasureResult {
	const monoMemoryLimit = options.monoMemoryLimit ?? DEFAULT_MONO_LIMIT;
	const counts = emptyCounts();
	const globalTypes = new Map<string, Type>();
	const functionReturnTypes = new Map<string, Type | 'void'>();
	for (const global of script.globals.values()) globalTypes.set(global.name, global.varType);
	for (const fn of script.functions.values()) functionReturnTypes.set(fn.name, fn.returnType ?? 'void');
	const baseContext: MeasureContext = { functionReturnTypes, symbolTypes: globalTypes, runtimeScope: 'body' };
	for (const global of script.globals.values()) measureGlobal(global, counts, baseContext);
	for (const fn of script.functions.values()) measureFunction(fn, counts, baseContext);
	for (const state of script.states.values()) measureState(state, counts, baseContext);

	const baseline = options.monoBaselineUsed ?? DEFAULT_BASELINE_USED;
	const cost: AstMeasureCostBuckets = {
		baseline,
		compiledBody: 0,
		declarations: declarationCost(script),
		containers: containerCost(counts),
		strings: stringCost(counts),
		controlFlow: controlFlowCost(counts),
		calls: callCost(counts),
		symbols: symbolCost(counts),
	};
	cost.compiledBody = Math.max(0, compiledBodyFloor(counts, baseline) - sumCost(cost));
	const estimatedMonoUsedMemory = Math.min(monoMemoryLimit, sumCost(cost));
	const notes = [
		'Static AST estimate calibrated from local SL Mono probes; use SL measurements for release-critical memory margins.',
	];
	return {
		monoMemoryLimit,
		estimatedMonoUsedMemory,
		estimatedMonoFreeMemory: Math.max(0, monoMemoryLimit - estimatedMonoUsedMemory),
		compactCharacters: emitScript(script, { compact: true }).length,
		sourceCharacters: options.sourceText?.length,
		counts,
		cost,
		notes,
	};
}

function emptyCounts(): AstMeasureCounts {
	return {
		globals: 0,
		functions: 0,
		states: 0,
		nonDefaultStates: 0,
		events: 0,
		parameters: 0,
		locals: 0,
		statements: 0,
		expressions: 0,
		calls: 0,
		builtinCalls: 0,
		userValueCalls: 0,
		ordinaryUserValueCalls: 0,
		userVoidCalls: 0,
		parameterizedEventUserValueCalls: 0,
		parameterizedEventCallRuntimeBytes: 0,
		listLiterals: 0,
		listCasts: 0,
		listElements: 0,
		listRuntimeBytes: 0,
		globalListRuntimeBytes: 0,
		localListRuntimeBytes: 0,
		localListLiteralRuntimeBytes: 0,
		localListCastRuntimeBytes: 0,
		castRuntimeBytes: 0,
		globalCastRuntimeBytes: 0,
		localCastRuntimeBytes: 0,
		vectorLiterals: 0,
		rotationLiterals: 0,
		stringLiterals: 0,
		stringLiteralCharacters: 0,
		identifierReferences: 0,
		identifierReferenceCharacters: 0,
		declaredNameCharacters: 0,
		labels: 0,
		stateChanges: 0,
	};
}

interface MeasureContext {
	functionReturnTypes: ReadonlyMap<string, Type | 'void'>;
	symbolTypes: Map<string, Type | 'void'>;
	runtimeScope: 'global' | 'body';
	eventParameterCount?: number;
}

interface ExprMeasureContext extends MeasureContext {
	insideListBuilder?: boolean;
	targetType?: Type;
}

function measureGlobal(global: GlobalVar, counts: AstMeasureCounts, ctx: MeasureContext): void {
	counts.globals++;
	counts.declaredNameCharacters += global.name.length;
	if (global.initializer) measureExpr(global.initializer, counts, { ...ctx, runtimeScope: 'global', targetType: global.varType });
}

function measureFunction(fn: FnNode, counts: AstMeasureCounts, ctx: MeasureContext): void {
	counts.functions++;
	counts.declaredNameCharacters += fn.name.length;
	measureParameters(fn.parameters, counts);
	const symbolTypes = new Map(ctx.symbolTypes);
	for (const [name, type] of fn.parameters) symbolTypes.set(name, type);
	measureStmt(fn.body, counts, { ...ctx, symbolTypes });
}

function measureState(state: State, counts: AstMeasureCounts, ctx: MeasureContext): void {
	counts.states++;
	counts.declaredNameCharacters += state.name.length;
	if (state.name !== 'default') counts.nonDefaultStates++;
	for (const event of state.events) measureEvent(event, counts, ctx);
}

function measureEvent(event: Event, counts: AstMeasureCounts, ctx: MeasureContext): void {
	counts.events++;
	counts.declaredNameCharacters += event.name.length;
	measureParameters(event.parameters, counts);
	const symbolTypes = new Map(ctx.symbolTypes);
	for (const [name, type] of event.parameters) symbolTypes.set(name, type);
	const beforeParameterizedCalls = counts.parameterizedEventUserValueCalls;
	measureStmt(event.body, counts, { ...ctx, symbolTypes, eventParameterCount: event.parameters.size });
	if (event.parameters.size > 0) {
		const eventCalls = counts.parameterizedEventUserValueCalls - beforeParameterizedCalls;
		counts.parameterizedEventCallRuntimeBytes += parameterizedEventCallCost(event.parameters.size, eventCalls);
	}
}

function measureParameters(parameters: ReadonlyMap<string, Type>, counts: AstMeasureCounts): void {
	counts.parameters += parameters.size;
	for (const name of parameters.keys()) counts.declaredNameCharacters += name.length;
}

function measureStmt(stmt: Stmt, counts: AstMeasureCounts, ctx: MeasureContext): void {
	counts.statements++;
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
			return;
		case 'ExprStmt':
			measureExpr(stmt.expression, counts, ctx);
			return;
		case 'VarDecl':
			counts.locals++;
			counts.declaredNameCharacters += stmt.name.length;
			if (stmt.initializer) measureExpr(stmt.initializer, counts, { ...ctx, targetType: stmt.varType });
			ctx.symbolTypes.set(stmt.name, stmt.varType);
			return;
		case 'ReturnStmt':
			if (stmt.expression) measureExpr(stmt.expression, counts, ctx);
			return;
		case 'IfStmt':
			measureExpr(stmt.condition, counts, ctx);
			measureStmt(stmt.then, counts, childContext(ctx));
			if (stmt.else) measureStmt(stmt.else, counts, childContext(ctx));
			return;
		case 'WhileStmt':
			measureExpr(stmt.condition, counts, ctx);
			measureStmt(stmt.body, counts, childContext(ctx));
			return;
		case 'DoWhileStmt':
			measureStmt(stmt.body, counts, childContext(ctx));
			measureExpr(stmt.condition, counts, ctx);
			return;
		case 'ForStmt':
			if (stmt.init) measureExpr(stmt.init, counts, ctx);
			if (stmt.condition) measureExpr(stmt.condition, counts, ctx);
			if (stmt.update) measureExpr(stmt.update, counts, ctx);
			measureStmt(stmt.body, counts, childContext(ctx));
			return;
		case 'BlockStmt':
			measureBlock(stmt.statements, counts, ctx);
			return;
		case 'JumpStmt':
			measureExpr(stmt.target, counts, ctx);
			return;
		case 'LabelStmt':
			counts.labels++;
			counts.declaredNameCharacters += stmt.name.length;
			return;
		case 'StateChangeStmt':
			counts.stateChanges++;
			counts.identifierReferenceCharacters += stmt.state.length;
			return;
		default:
			AssertNever(stmt);
	}
}

function measureBlock(statements: readonly Stmt[], counts: AstMeasureCounts, ctx: MeasureContext): void {
	const blockContext = childContext(ctx);
	for (const child of statements) measureStmt(child, counts, blockContext);
}

function childContext(ctx: MeasureContext): MeasureContext {
	return { ...ctx, symbolTypes: new Map(ctx.symbolTypes) };
}

function measureExpr(expr: Expr, counts: AstMeasureCounts, context: ExprMeasureContext): void {
	counts.expressions++;
	const listBuilder = listBuilderShape(expr);
	if (!context.insideListBuilder && listBuilder) addListRuntimeCost(counts, context, listBuilder, listBuilderCost(listBuilder));
	const listChildContext = listBuilder ? { ...context, insideListBuilder: true, targetType: undefined } : { ...context, targetType: undefined };
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'NumberLiteral':
			return;
		case 'StringLiteral':
			counts.stringLiterals++;
			counts.stringLiteralCharacters += expr.value.length;
			return;
		case 'Identifier':
			counts.identifierReferences++;
			counts.identifierReferenceCharacters += expr.name.length;
			return;
		case 'Call':
			counts.calls++;
			measureCallKind(expr, counts, context);
			measureExpr(expr.callee, counts, { ...context, targetType: undefined });
			for (const arg of expr.args) measureExpr(arg, counts, { ...context, targetType: undefined });
			return;
		case 'Member':
			measureExpr(expr.object, counts, { ...context, targetType: undefined });
			counts.identifierReferenceCharacters += expr.property.length;
			return;
		case 'Unary':
			measureExpr(expr.argument, counts, { ...context, targetType: undefined });
			return;
		case 'Binary':
			measureExpr(expr.left, counts, listChildContext);
			measureExpr(expr.right, counts, listChildContext);
			return;
		case 'Cast':
			if (expr.type === 'list') counts.listCasts++;
			addCastRuntimeCost(counts, context, castRuntimeCost(expr, context));
			measureExpr(expr.argument, counts, listChildContext);
			return;
		case 'Paren':
			measureExpr(expr.expression, counts, { ...listChildContext, targetType: context.targetType });
			return;
		case 'ListLiteral':
			counts.listLiterals++;
			counts.listElements += expr.elements.length;
			for (const element of expr.elements) measureExpr(element, counts, listChildContext);
			return;
		case 'VectorLiteral':
			if (expr.elements.length === 4) counts.rotationLiterals++;
			else counts.vectorLiterals++;
			for (const element of expr.elements) measureExpr(element, counts, { ...context, targetType: undefined });
			return;
		default:
			AssertNever(expr);
	}
}

function addListRuntimeCost(counts: AstMeasureCounts, context: MeasureContext, shape: ListBuilderShape, value: number): void {
	counts.listRuntimeBytes += value;
	if (context.runtimeScope === 'global') counts.globalListRuntimeBytes += value;
	else {
		counts.localListRuntimeBytes += value;
		if (shape.source === 'cast') counts.localListCastRuntimeBytes += value;
		else counts.localListLiteralRuntimeBytes += value;
	}
}

function addCastRuntimeCost(counts: AstMeasureCounts, context: MeasureContext, value: number): void {
	counts.castRuntimeBytes += value;
	if (context.runtimeScope === 'global') counts.globalCastRuntimeBytes += value;
	else counts.localCastRuntimeBytes += value;
}

function measureCallKind(expr: Extract<Expr, { kind: 'Call' }>, counts: AstMeasureCounts, context: MeasureContext): void {
	if (expr.callee.kind !== 'Identifier') {
		counts.builtinCalls++;
		return;
	}
	const returnType = context.functionReturnTypes.get(expr.callee.name);
	if (returnType === undefined) {
		counts.builtinCalls++;
		return;
	}
	if (returnType === 'void') counts.userVoidCalls++;
	else {
		counts.userValueCalls++;
		if (context.eventParameterCount && context.eventParameterCount > 0) counts.parameterizedEventUserValueCalls++;
		else counts.ordinaryUserValueCalls++;
	}
}

function parameterizedEventCallCost(parameterCount: number, valueCalls: number): number {
	if (valueCalls === 0) return 0;
	const secondStepThreshold = Math.max(2, 4 - parameterCount);
	return valueCalls >= secondStepThreshold ? 1024 : 512;
}

function castRuntimeCost(expr: Extract<Expr, { kind: 'Cast' }>, context: ExprMeasureContext): number {
	if (expr.type === 'string') {
		const sourceType = exprType(expr.argument, context);
		if (sourceType === 'key' || sourceType === 'rotation') return 512;
		if (sourceType === 'vector' && expr.argument.kind === 'Identifier') return 512;
		return 0;
	}
	if (expr.type === 'key' && context.targetType === 'key' && expr.argument.kind === 'Identifier' && exprType(expr.argument, context) === 'string') {
		return 512;
	}
	return 0;
}

function exprType(expr: Expr, context: MeasureContext): Type | 'void' | undefined {
	if (expr.kind === 'Paren') return exprType(expr.expression, context);
	if (expr.kind === 'Identifier') return context.symbolTypes.get(expr.name);
	if (expr.kind === 'StringLiteral') return 'string';
	if (expr.kind === 'VectorLiteral') return expr.elements.length === 4 ? 'rotation' : 'vector';
	if (expr.kind === 'ListLiteral') return 'list';
	if (expr.kind === 'Cast') return expr.type;
	if (expr.kind === 'Call' && expr.callee.kind === 'Identifier') return context.functionReturnTypes.get(expr.callee.name);
	return undefined;
}

type ListBuilderSource = 'emptyLiteral' | 'literal' | 'cast';
interface ListBuilderShape {
	source: ListBuilderSource;
	elements: number;
	heavyElement: boolean;
	listConcat: boolean;
}

function listBuilderShape(expr: Expr): ListBuilderShape | null {
	switch (expr.kind) {
		case 'Paren':
			return listBuilderShape(expr.expression);
		case 'ListLiteral':
			return {
				source: expr.elements.length === 0 ? 'emptyLiteral' : 'literal',
				elements: expr.elements.length,
				heavyElement: expr.elements.some(isHeavyListElement),
				listConcat: false,
			};
		case 'Cast':
			if (expr.type !== 'list') return null;
			return {
				source: 'cast',
				elements: 1,
				heavyElement: isHeavyListElement(expr.argument),
				listConcat: false,
			};
		case 'Binary':
			if (expr.op !== '+') return null;
			return combineListBuilderShape(expr.left, expr.right);
		default:
			return null;
	}
}

function combineListBuilderShape(left: Expr, right: Expr): ListBuilderShape | null {
	const leftShape = listBuilderShape(left);
	if (!leftShape) return null;
	const rightShape = listBuilderShape(right);
	if (rightShape) {
		return {
			source: leftShape.source,
			elements: leftShape.elements + rightShape.elements,
			heavyElement: leftShape.heavyElement || rightShape.heavyElement,
			listConcat: true,
		};
	}
	return {
		source: leftShape.source,
		elements: leftShape.elements + 1,
		heavyElement: leftShape.heavyElement || isHeavyListElement(right),
		listConcat: leftShape.listConcat,
	};
}

function listBuilderCost(shape: ListBuilderShape): number {
	if (shape.listConcat) return 512;
	if (shape.heavyElement) return 512;
	if (shape.source === 'literal' && shape.elements >= 3) return 512;
	if (shape.source === 'cast' && shape.elements >= 4) return 512;
	return 0;
}

function isHeavyListElement(expr: Expr): boolean {
	if (expr.kind === 'Paren') return isHeavyListElement(expr.expression);
	if (expr.kind === 'VectorLiteral') return true;
	if (expr.kind === 'Cast' && (expr.type === 'vector' || expr.type === 'rotation')) return true;
	return false;
}

function declarationCost(script: Script): number {
	let cost = 0;
	for (const global of script.globals.values()) cost += globalTypeCost(global.varType, global.initializer !== undefined);
	return cost;
}

function globalTypeCost(type: Type, initialized: boolean): number {
	switch (type) {
		case 'integer':
		case 'float':
			return initialized ? 8 : 4;
		case 'key':
			return initialized ? 40 : 8;
		case 'string':
			return initialized ? 24 : 8;
		case 'vector':
		case 'rotation':
			return initialized ? 268 : 0;
		case 'list':
			return initialized ? 36 : 0;
		default:
			AssertNever(type);
			return 0;
	}
}

function containerCost(counts: AstMeasureCounts): number {
	return counts.globalListRuntimeBytes + counts.globalCastRuntimeBytes;
}

function stringCost(counts: AstMeasureCounts): number {
	void counts;
	return 0;
}

function controlFlowCost(counts: AstMeasureCounts): number {
	return counts.labels * 24;
}

function callCost(counts: AstMeasureCounts): number {
	let cost = 0;
	if (counts.ordinaryUserValueCalls >= 3) cost += 512;
	cost += counts.parameterizedEventCallRuntimeBytes;
	if (counts.builtinCalls >= 4) cost += 568;
	else if (counts.builtinCalls >= 3) cost += 94;
	return cost;
}

function symbolCost(counts: AstMeasureCounts): number {
	void counts;
	return 0;
}

function compiledBodyFloor(counts: AstMeasureCounts, baseline: number): number {
	const globalContainers = counts.globalListRuntimeBytes + counts.globalCastRuntimeBytes;
	return Math.round(
		baseline
		+ counts.expressions * 5
		+ counts.calls * 43
		+ counts.functions * 280
		+ counts.events * 300
		+ counts.globals * 100
		+ counts.parameters * 20
		+ counts.locals * 45
		+ counts.stringLiteralCharacters * 1.5
		+ counts.labels * 24
		+ globalContainers * 0.4
		+ counts.localListLiteralRuntimeBytes * 0.34
		+ counts.parameterizedEventUserValueCalls * 64,
	);
}

function sumCost(cost: AstMeasureCostBuckets): number {
	return Object.values(cost).reduce((sum, value) => sum + value, 0);
}
