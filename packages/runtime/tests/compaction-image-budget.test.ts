import { describe, expect, it } from 'vitest';
import { estimateCompactionMessagesTokens } from '../src/compaction.js';

describe('retained image compaction budget', () => {
	it.each(['user', 'toolResult'] as const)('counts each %s image as 500 tokens', (role) => {
		const message = {
			role,
			content: [
				{ type: 'text', text: 'text' },
				{ type: 'image', data: 'small', mimeType: 'image/png' },
				{ type: 'image', data: 'large'.repeat(10_000), mimeType: 'image/jpeg' },
			],
			timestamp: 1,
			...(role === 'toolResult' ? { toolCallId: 'image-call', toolName: 'image', isError: false } : {}),
		} as Parameters<typeof estimateCompactionMessagesTokens>[0][number];
		expect(estimateCompactionMessagesTokens([message])).toBe(1_005);
	});
});
