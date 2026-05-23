import type { SimpleType } from './infer';

const isNumeric = (type: SimpleType) => type === 'integer' || type === 'float';

export function isAssignmentCompatible(target: SimpleType, source: SimpleType) {
	if (target === 'any' || source === 'any') return true;
	if (target === source) return true;
	if (target === 'float' && source === 'integer') return true;
	if ((target === 'string' || target === 'key') && (source === 'string' || source === 'key')) return true;
	return false;
}

export function areEqualityComparable(
	left: SimpleType,
	right: SimpleType,
	leftIsList: boolean,
	rightIsList: boolean,
) {
	if (left === 'any' || right === 'any') return true;
	if (leftIsList || rightIsList) return leftIsList && rightIsList;
	if (isNumeric(left) && isNumeric(right)) return true;
	if ((left === 'string' || left === 'key') && (right === 'string' || right === 'key')) return true;
	return left === right && (left === 'vector' || left === 'rotation');
}
