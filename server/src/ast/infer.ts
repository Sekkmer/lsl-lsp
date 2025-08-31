import { Expr, Type } from './index';
import { AssertNever } from '../utils';

// Include 'void' so inference can represent void-returning calls distinctly
export type SimpleType = Type | 'any' | 'void';

const isNumeric = (t: SimpleType) => t === 'integer' || t === 'float';

export function inferExprTypeFromAst(
	expr: Expr | null,
	symbolTypes: Map<string, SimpleType>,
	functionReturnTypes?: Map<string, SimpleType>,
): SimpleType {
	if (!expr) return 'any';
	switch (expr.kind) {
		case 'ErrorExpr': return 'any';
		case 'Paren': return inferExprTypeFromAst(expr.expression, symbolTypes, functionReturnTypes);
		case 'StringLiteral': return 'string';
		case 'NumberLiteral': return expr.raw.includes('.') ? 'float' : 'integer';
		case 'VectorLiteral': {
			if (expr.elements.length === 3) return 'vector';
			if (expr.elements.length === 4) return 'rotation';
			AssertNever(expr.elements, 'VectorLiteral with invalid number of components');
			return 'any';
		}
		case 'ListLiteral': return 'list';
		case 'Identifier': return symbolTypes.get(expr.name) ?? 'any';
		case 'Cast': return expr.type;
		case 'Unary': {
			// Logical and bitwise nots yield integer; arithmetic +/- preserve numeric where possible; ++/-- yield integer
			if (expr.op === '!' || expr.op === '~' || expr.op === '++' || expr.op === '--') return 'integer';
			const t = inferExprTypeFromAst(expr.argument, symbolTypes, functionReturnTypes);
			if ((expr.op === '+' || expr.op === '-') && isNumeric(t)) return t;
			return 'any';
		}
		case 'Call': {
			// Attempt to infer from function return types if callee is a simple identifier
			let name: string | null = null;
			if (expr.callee.kind === 'Identifier') name = expr.callee.name;
			if (name && functionReturnTypes) {
				const rt = functionReturnTypes.get(name);
				// If we have a known return type (including 'void'), return it; otherwise fall back to 'any'
				if (rt !== undefined) return rt;
			}
			return 'any';
		}
		case 'Member': {
			// vector.x / rotation.s -> float
			return 'float';
		}
		case 'Binary': {
			const lt = inferExprTypeFromAst(expr.left, symbolTypes, functionReturnTypes);
			const rt = inferExprTypeFromAst(expr.right, symbolTypes, functionReturnTypes);
			const op = expr.op;
			// Logical/relational/bitwise ops yield integer
			if (op === '&&' || op === '||' || op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=' || op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>') return 'integer';
			if (isNumeric(lt) && isNumeric(rt)) return lt === 'float' || rt === 'float' ? 'float' : 'integer';
			if (expr.op[0] === '+') {
				if (lt === 'list' || rt === 'list') return 'list';
				if (lt === 'string' || rt === 'string') return 'string';
				if (lt === 'vector' && rt === 'vector') return 'vector';
				if (lt === 'rotation' && rt === 'rotation') return 'rotation';
				return 'any';
			}
			if (expr.op[0] === '-') {
				if (lt === 'vector' && rt === 'vector') return 'vector';
				if (lt === 'rotation' && rt === 'rotation') return 'rotation';
				return 'any';
			}
			if (expr.op[0] === '%') {
				if (lt === 'vector' && rt === 'vector') return 'vector';
				return 'any';
			}
			if (expr.op[0] === '*') {
				if (lt === 'vector' && rt === 'vector') return 'float';
				if ((lt === 'vector' || lt === 'rotation') && isNumeric(rt)) return lt;
				if (isNumeric(lt) && (rt === 'vector' || rt === 'rotation')) return rt;
				if (lt === 'vector' && rt === 'rotation') return 'vector';
				return 'any';
			}
			if (expr.op[0] === '/') {
				if ((lt === 'vector' || lt === 'rotation') && isNumeric(rt)) return lt;
				if (lt === 'vector' && rt === 'rotation') return 'vector';
				return 'any';
			}
			return 'any';
		}
	}
	AssertNever(expr, 'Unhandled expression type');
	return 'any';
}

export function isZeroLiteral(expr: Expr | null): boolean {
	if (!expr) return false;
	if (expr.kind === 'NumberLiteral') {
		const n = Number.parseFloat(expr.raw);
		return Number.isFinite(n) && n === 0;
	}
	return false;
}
