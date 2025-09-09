/* Centralized helpers for built-in macros and URI filename handling */

// Compute a display filename (basename) from a VSCode-style URI or raw path
export function basenameFromUri(uri: string): string {
	try {
		const u = new URL(uri);
		const p = u.protocol === 'file:' ? decodeURIComponent(u.pathname) : uri;
		const parts = p.split(/[\\/]/);
		return parts[parts.length - 1] || 'memory.lsl';
	} catch {
		const parts = uri.replace(/^file:\/\//, '').split(/[\\/]/);
		return parts[parts.length - 1] || 'memory.lsl';
	}
}

// Generate expansion for built-in macros at lexing time.
// Return token kind and already JSON-encoded string when kind==='string'.
export function builtinMacroForLexer(
	name: string,
	ctx: { filename: string; line: number; now?: Date }
): { kind: 'number' | 'string'; value: string } | null {
	switch (name) {
		case '__LINE__':
			return { kind: 'number', value: String(ctx.line) };
		case '__FILE__':
			// Defer __FILE__ expansion until AST parser builtin pass so we can reliably
			// compute the basename from the final document URI. Returning null keeps
			// the identifier token intact through preprocessing/macro expansion.
			return null; // handled later in parser.applyBuiltinExpansions
		case '__TIME__': {
			const d = ctx.now ?? new Date();
			const time = d.toLocaleTimeString('en-US', { hour12: false });
			return { kind: 'string', value: JSON.stringify(time) };
		}
		case '__DATE__': {
			const d = ctx.now ?? new Date();
			// Keep behavior stable: US locale date, UTC zone for determinism in tests
			const date = d.toLocaleDateString('en-US', { timeZone: 'UTC' });
			return { kind: 'string', value: JSON.stringify(date) };
		}
		default:
			return null;
	}
}
