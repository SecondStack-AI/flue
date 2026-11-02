import { getConversationFoldHost } from '../conversation-fold-host.ts';
import {
	type AgentConversationSnapshot,
	type ConversationStreamChunk,
	projectAgentConversationBatch,
	projectSettlements,
} from '../conversation-public.ts';
import { selectRootConversation } from '../conversation-reducer.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';
import { formatOffset, parseOffset } from './stream-offsets.ts';

type Position = ConversationStreamChunk['position'];

export interface AgentSubmissionUpdatesPage {
	chunks: ConversationStreamChunk[];
	cursor?: Position;
	truncated: boolean;
	identities: { messageIds: string[]; toolCallIds: string[] };
	settlement?: AgentConversationSnapshot['settlements'][number];
}

/** Submission recovery over canonical batches, using the shared fold's historical identity index. */
export async function readAgentSubmissionUpdates(options: {
	store: ConversationStreamStore;
	path: string;
	submissionId: string;
	after?: Position;
	batchLimit?: number;
}): Promise<AgentSubmissionUpdatesPage> {
	const state = await getConversationFoldHost(options.store, options.path).getStateAtHead();
	const conversation = selectRootConversation(state);
	const index = state.submissionStreams.get(options.submissionId);
	if (!conversation || index === undefined)
		return {
			chunks: [] as ConversationStreamChunk[],
			truncated: false,
			identities: { messageIds: [] as string[], toolCallIds: [] as string[] },
			settlement: undefined,
		};
	const messageIds = new Set(index.messageIds);
	const toolCallIds = new Set(index.toolCallIds);
	const after = options.after;
	const firstBatch = parseOffset(index.firstOffset);
	const resumeBatch =
		after === undefined
			? firstBatch - 1
			: after.batch - (after.index === Number.MAX_SAFE_INTEGER ? 0 : 1);
	const head = parseOffset(state.recordsThroughOffset);
	const read = await options.store.read(options.path, {
		offset: formatOffset(Math.min(head, Math.max(firstBatch - 1, resumeBatch))),
		limit: options.batchLimit ?? 100,
	});
	const chunks: ConversationStreamChunk[] = [];
	// A concurrent append may be newer than this page's fold head; preserve the consumed position.
	let cursor: Position | undefined = after;
	let scanned = 0;
	let cut = false;
	readBatches: for (const batch of read.batches) {
		const batchOrdinal = parseOffset(batch.offset);
		if (batchOrdinal > head) break;
		const responseIds = new Map<string, string>();
		for (const record of batch.records) {
			if (!record.submissionId) continue;
			const response = state.submissionStreams
				.get(record.submissionId)
				?.responses.findLast((item) => parseOffset(item.offset) <= batchOrdinal);
			if (response) responseIds.set(record.submissionId, response.messageId);
			else responseIds.delete(record.submissionId);
		}
		// Conversation resets subsume a batch and are outside a submission stream.
		// Their identities were indexed at the validated historical batch boundary.
		const reset = state.resetOffsets.has(batch.offset);
		const projected = reset
			? []
			: projectAgentConversationBatch({
					state,
					records: batch.records,
					batchOrdinal,
					responseIds,
					snapshotReset: false,
				});
		if (reset && (!after || batchOrdinal > after.batch)) {
			if (scanned >= 512) {
				cut = true;
				break;
			}
			scanned += 1;
		}
		const outputToolCallIds = new Set<string>();
		for (const record of batch.records) {
			if (
				record.type !== 'tool_results_committed' ||
				record.conversationId !== conversation.conversationId ||
				record.submissionId !== options.submissionId
			)
				continue;
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type === 'message' && assistant.message.role === 'assistant')
				for (const block of assistant.message.content)
					if (block.type === 'toolCall') outputToolCallIds.add(block.id);
		}
		for (const chunk of projected) {
			if (
				after &&
				(chunk.position.batch < after.batch ||
					(chunk.position.batch === after.batch && chunk.position.index <= after.index))
			)
				continue;
			if (scanned >= 512) {
				cut = true;
				break readBatches;
			}
			scanned += 1;
			cursor = chunk.position;
			const accepted = (() => {
				switch (chunk.type) {
					case 'message-started':
						return chunk.submissionId === options.submissionId;
					case 'message-delta':
					case 'message-metadata':
					case 'data-part':
					case 'message-completed':
						return messageIds.has(chunk.messageId);
					case 'tool-input':
						return messageIds.has(chunk.messageId) && toolCallIds.has(chunk.toolCallId);
					case 'tool-output':
					case 'tool-output-error':
						return outputToolCallIds.has(chunk.toolCallId);
					case 'submission-settled':
						return chunk.submissionId === options.submissionId;
					case 'message-appended':
						return chunk.message.role === 'user';
					case 'conversation-reset':
						return false;
				}
			})();
			if (accepted) chunks.push(chunk);
		}
		cursor = { batch: batchOrdinal, index: Number.MAX_SAFE_INTEGER };
	}
	return {
		chunks,
		...(cursor === undefined ? {} : { cursor }),
		truncated:
			cut || !read.upToDate || read.batches.some((batch) => parseOffset(batch.offset) > head),
		identities: { messageIds: [...messageIds], toolCallIds: [...toolCallIds] },
		settlement: projectSettlements(state, conversation.conversationId).find(
			(item) => item.submissionId === options.submissionId,
		),
	};
}

export function createAgentSubmissionChunkFilter(submissionId: string) {
	const messageIds = new Set<string>();
	const toolCallIds = new Set<string>();
	let started = false;
	return (chunk: ConversationStreamChunk): boolean => {
		switch (chunk.type) {
			case 'conversation-reset':
				for (const message of chunk.snapshot.messages) {
					const own = message.role === 'assistant' && message.submissionId === submissionId;
					if (own) {
						started = true;
						messageIds.add(message.id);
					}
					if (message.role === 'user' && message.submissionId === submissionId) started = true;
					for (const part of message.parts)
						if (part.type === 'dynamic-tool') {
							if (own) toolCallIds.add(part.toolCallId);
							else toolCallIds.delete(part.toolCallId);
						}
				}
				if (chunk.snapshot.settlements.some((item) => item.submissionId === submissionId))
					started = true;
				return false;
			case 'message-started':
				if (chunk.submissionId !== submissionId) return false;
				started = true;
				messageIds.add(chunk.messageId);
				return true;
			case 'message-appended':
				if (chunk.message.role !== 'user') return false;
				if (chunk.message.submissionId === submissionId) started = true;
				return started;
			case 'tool-input':
				if (!messageIds.has(chunk.messageId)) {
					toolCallIds.delete(chunk.toolCallId);
					return false;
				}
				toolCallIds.add(chunk.toolCallId);
				return true;
			case 'tool-output':
			case 'tool-output-error':
				return toolCallIds.has(chunk.toolCallId);
			case 'message-delta':
			case 'message-metadata':
			case 'data-part':
			case 'message-completed':
				return messageIds.has(chunk.messageId);
			case 'submission-settled':
				if (chunk.submissionId !== submissionId) return false;
				started = true;
				return true;
		}
	};
}
