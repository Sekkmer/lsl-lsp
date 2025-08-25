import path from 'node:path';
import { loadDefs } from '../src/defs';

export async function loadTestDefs() {
	const p = path.join(__dirname, 'fixtures', 'lsl-defs.json');
	return loadDefs(p);
}
