import { requireRenderFrame } from './frame.ts';

/** Applications that own workspace guidance and per-turn time can disable the generated preamble. */
export function useEnvironmentPreamble(enabled: boolean): void {
	if (typeof enabled !== 'boolean')
		throw new Error('[flue] useEnvironmentPreamble() requires a boolean.');
	requireRenderFrame('useEnvironmentPreamble').environmentPreamble = enabled;
}
