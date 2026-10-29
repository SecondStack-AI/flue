import { requireRenderFrame } from './frame.ts';

/** Latest committed compaction identity, for application-owned context baselines. */
export function useContextEpoch(): string | undefined {
	return requireRenderFrame('useContextEpoch').state?.contextEpoch;
}
