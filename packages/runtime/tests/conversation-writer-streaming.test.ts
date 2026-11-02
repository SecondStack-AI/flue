import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConversationFoldHost } from '../src/conversation-fold-host.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import { InMemoryConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';
import { readAgentSubmissionUpdates } from '../src/runtime/submission-updates.ts';

afterEach(() => vi.useRealTimers());

async function liveWriter() {
	const store = new InMemoryConversationStreamStore();
	const path = 'agents/writer-proof/retained';
	const writer = await ConversationRecordWriter.create({
		store,
		path,
		identity: { agentName: 'writer-proof', instanceId: 'retained' },
		producerId: 'writer',
	});
	const envelope = {
		v: 1 as const,
		conversationId: 'conv',
		harness: 'default',
		session: 'default',
		timestamp: '2026-11-02T00:00:00.000Z',
	};
	await writer.ensureConversation({
		...envelope,
		kind: 'root',
		affinityKey: 'conv',
		createdAt: envelope.timestamp,
	});
	const own = { ...envelope, submissionId: 'target', attemptId: 'attempt' };
	const options = { submission: { submissionId: 'target', attemptId: 'attempt' } };
	const input = await writer.append(
		[
			{
				...own,
				type: 'user_message',
				id: 'input',
				messageId: 'entry_input',
				parentId: null,
				content: [{ type: 'text', text: 'Hello' }],
			},
		],
		options,
	);
	await writer.append(
		[
			{
				...own,
				type: 'assistant_message_started',
				id: 'started',
				messageId: 'entry_answer',
				parentId: 'entry_input',
				modelInfo: { api: 'openai-completions', provider: 'test', model: 'test' },
			},
			{
				...own,
				type: 'assistant_text_started',
				id: 'text_started',
				messageId: 'entry_answer',
				blockId: 'text',
				blockIndex: 0,
			},
		],
		options,
	);
	const delta = (sequence: number, text: string): ConversationRecord => ({
		...own,
		type: 'assistant_text_delta',
		id: `delta_${sequence}`,
		messageId: 'entry_answer',
		blockId: 'text',
		sequence,
		delta: text,
	});
	return { store, path, writer, options, input, delta };
}

describe('canonical streaming writer', () => {
	it('indexes the batch being appended rather than the previously folded offset', async () => {
		const { store, path, input } = await liveWriter();
		const state = await getConversationFoldHost(store, path).getStateAtHead();
		expect(state.submissionStreams.get('target')?.firstOffset).toBe(input.offset);
		const page = await readAgentSubmissionUpdates({ store, path, submissionId: 'target' });
		expect(page.chunks.map((chunk) => chunk.type)).toEqual(['message-appended', 'message-started']);
	});

	it('durably flushes a queued mid-block tail within 250 ms without waiting for completion', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
		const { store, path, writer, options, delta } = await liveWriter();
		const first = writer.enqueue([delta(0, 'Hi')], options);
		await vi.advanceTimersByTimeAsync(0);
		const leading = await first;
		await vi.advanceTimersByTimeAsync(50);
		const tail = writer.enqueue([delta(1, ' Alex.')], options);
		let flushed = false;
		void tail.then(() => {
			flushed = true;
		});
		await vi.advanceTimersByTimeAsync(249);
		expect((await store.read(path, { offset: leading.offset })).batches).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(flushed).toBe(true);
		await tail;
		const read = await store.read(path, { offset: leading.offset });
		expect(read.batches.flatMap((batch) => batch.records)).toEqual([delta(1, ' Alex.')]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
