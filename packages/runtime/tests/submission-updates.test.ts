import { describe, expect, it, vi } from 'vitest';
import { AgentRunError, init } from '../src/agent-client.ts';
import type { ConversationStreamChunk } from '../src/conversation-public.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { toolResultEntryId } from '../src/conversation-reducer.ts';
import { createAgentRouter } from '../src/routing.ts';
import { InMemoryAttachmentStore } from '../src/runtime/attachment-store.ts';
import {
	type ConversationStreamStore,
	InMemoryConversationStreamStore,
} from '../src/runtime/conversation-stream-store.ts';
import { configureFlueRuntime, getFlueRuntime } from '../src/runtime/flue-app.ts';
import { registerFlueAgents } from '../src/runtime/registration.ts';
import { formatOffset, parseOffset } from '../src/runtime/stream-offsets.ts';
import { readAgentSubmissionUpdates } from '../src/runtime/submission-updates.ts';
import { createTaskSessionName } from '../src/session-identity.ts';

function StreamProofAgent(): never {
	throw new Error('Submission stream proof must not execute an agent');
}
StreamProofAgent.agentName = 'stream-proof';
registerFlueAgents([{ identity: StreamProofAgent.agentName, agent: StreamProofAgent }]);
const unexpectedExecution = async (): Promise<never> => {
	throw new Error('Submission stream proof must not execute work');
};
function registerProjectionOracle(store: ConversationStreamStore) {
	configureFlueRuntime({
		target: 'node',
		conversationStreamStore: store,
		attachmentStore: new InMemoryAttachmentStore(),
		dispatchQueue: { enqueue: unexpectedExecution },
		createAgentAdmission: () => {
			throw new Error('Submission stream proof must not admit');
		},
		abortAgentInstance: unexpectedExecution,
		compactAgentInstance: unexpectedExecution,
	});
}
async function handleAgentConversationRead(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}) {
	const url = new URL(options.request.url);
	url.pathname = '/retained';
	return createAgentRouter(StreamProofAgent).fetch(new Request(url));
}
async function cloudflareReadScopes(
	defaultEvents: ConversationStreamChunk[],
	submissionId: string,
) {
	const response = await createAgentRouter(StreamProofAgent).fetch(
		new Request('http://flue/retained'),
	);
	expect(response.ok).toBe(true);
	const snapshot = await response.json();
	const previous = getFlueRuntime();
	if (!previous) throw new Error('Submission stream proof lost its Node runtime');
	const runs = [];
	try {
		for (const scope of [undefined, 'submission'] as const) {
			let read = false;
			configureFlueRuntime({
				target: 'cloudflare',
				dispatchQueue: { enqueue: unexpectedExecution },
				instanceInfo: async () => ({ id: 'retained', uid: 'retained-incarnation' }),
				routeAgentRequest: async (request) => {
					const view = new URL(request.url).searchParams.get('view');
					if (view === 'history') return Response.json(snapshot);
					if (view !== 'updates' || read)
						throw new Error('Submission stream proof exhausted Cloudflare pages');
					read = true;
					return Response.json(defaultEvents, { headers: { 'Stream-Next-Offset': '1' } });
				},
			});
			const events: ConversationStreamChunk[] = [];
			try {
				const reply = await init(StreamProofAgent, { id: 'retained' }).read(
					{ submissionId, uid: 'retained-incarnation', acceptedAt: '2026-10-29T00:00:00.000Z' },
					{ ...(scope ? { scope } : {}), onEvent: (chunk) => events.push(chunk) },
				);
				runs.push({ status: 'fulfilled', reply, events });
			} catch (error) {
				if (!(error instanceof AgentRunError)) throw error;
				runs.push({
					status: 'rejected',
					error: {
						name: error.name,
						outcome: error.outcome,
						submissionId: error.submissionId,
						cause: error.cause,
					},
					events,
				});
			}
		}
	} finally {
		configureFlueRuntime(previous);
	}
	const ordinary = runs[0];
	const scoped = runs[1];
	if (!ordinary || !scoped) throw new Error('Submission stream proof omitted a transport scope');
	return [ordinary, scoped] as const;
}
const envelope = {
	v: 1 as const,
	conversationId: 'conv',
	harness: 'default',
	session: 'default',
	timestamp: '2026-10-29T00:00:00.000Z',
};
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function retainedStream(
	historyBatches: number,
	finish: 'stop' | 'error' | 'aborted' = 'stop',
	settle = true,
) {
	const store = new InMemoryConversationStreamStore();
	const agentName = StreamProofAgent.agentName;
	if (agentName === undefined) throw new Error('Submission stream proof agent has no durable name');
	const path = `agents/${agentName}/retained`;
	await registerProjectionOracle(store);
	await store.createStream(path, { agentName, instanceId: 'retained' });
	const claim = await store.acquireProducer(path, 'test');
	let sequence = 0;
	const append = async (records: ConversationRecord[], submissionId?: string) =>
		store.append({
			path,
			...claim,
			producerSequence: sequence++,
			records,
			...(submissionId
				? { submission: { submissionId, attemptId: records[0]?.attemptId ?? 'attempt' } }
				: {}),
		});
	await append([
		{
			...envelope,
			type: 'conversation_created',
			id: 'born',
			kind: 'root',
			affinityKey: 'conv',
			createdAt: envelope.timestamp,
		},
	]);
	let parentId: string | null = null;
	for (let index = 0; index < historyBatches; index++) {
		const messageId = `entry_old_${index}`;
		await append([
			{
				...envelope,
				type: 'user_message',
				id: `old_${index}`,
				messageId,
				parentId,
				content: [{ type: 'text', text: 'sanitized retained history '.repeat(40) }],
			},
		]);
		parentId = messageId;
	}
	const start = historyBatches + 1;
	const owned = { ...envelope, submissionId: 'target', attemptId: 'attempt' };
	await append(
		[
			{
				...owned,
				type: 'user_message',
				id: 'input',
				messageId: 'entry_input',
				parentId,
				content: [{ type: 'text', text: 'Hello' }],
			},
		],
		'target',
	);
	await append(
		[
			{
				...owned,
				type: 'assistant_message_started',
				id: 'started',
				messageId: 'entry_answer',
				parentId: 'entry_input',
				modelInfo: { api: 'openai-completions', provider: 'test', model: 'test' },
			},
			{
				...owned,
				type: 'assistant_text_started',
				id: 'text_started',
				messageId: 'entry_answer',
				blockId: 'block_text',
				blockIndex: 0,
			},
		],
		'target',
	);
	for (let index = 0; index < 12; index++)
		await append(
			[
				{
					...owned,
					type: 'assistant_text_delta',
					id: `delta_${index}`,
					messageId: 'entry_answer',
					blockId: 'block_text',
					sequence: index,
					delta: `${index} `,
				},
			],
			'target',
		);
	if (finish === 'aborted')
		await append(
			[
				{
					...owned,
					type: 'submission_settled',
					id: 'aborted',
					outcome: 'aborted',
					error: { type: 'stop' },
				},
			],
			'target',
		);
	else
		await append(
			[
				{
					...owned,
					type: 'assistant_text_completed',
					id: 'text_done',
					messageId: 'entry_answer',
					blockId: 'block_text',
					deltaCount: 12,
				},
				{
					...owned,
					type: 'assistant_message_completed',
					id: 'done',
					messageId: 'entry_answer',
					stopReason: finish,
					usage,
				},
				...(settle
					? [
							{
								...owned,
								type: 'submission_settled' as const,
								id: 'settled',
								outcome: 'completed' as const,
							},
						]
					: []),
			],
			'target',
		);
	return { store, path, start, append };
}

describe('bounded durable submission updates', () => {
	it.each(['stop', 'aborted', 'failed'] as const)(
		'keeps default/scoped replies and typed %s outcomes equivalent',
		async (outcome) => {
			const fixture = await retainedStream(30, outcome === 'aborted' ? 'aborted' : 'stop', false);
			const { store, path, append } = fixture;
			if (outcome !== 'aborted') {
				const own = { ...envelope, submissionId: 'target', attemptId: 'attempt' };
				await append(
					[
						{
							...own,
							type: 'message_data_write',
							id: 'response_data',
							name: 'proof',
							data: { durable: true },
						},
						{
							...own,
							type: 'message_metadata',
							id: 'response_metadata',
							metadata: { proof: 'retained' },
						},
						{
							...own,
							type: 'submission_settled',
							id: 'proof_settled',
							outcome: outcome === 'failed' ? 'failed' : 'completed',
							...(outcome === 'failed' ? { error: { type: 'proof_failure' } } : {}),
						},
					],
					'target',
				);
			}
			const expected = await readAgentSubmissionUpdates({ store, path, submissionId: 'target' });
			const handle = init(StreamProofAgent, { id: 'retained' });
			const defaultEvents: ConversationStreamChunk[] = [];
			const scopedEvents: ConversationStreamChunk[] = [];
			const receipt = {
				submissionId: 'target',
				uid: 'retained-incarnation',
				acceptedAt: envelope.timestamp,
			};
			const [ordinary, scoped] = await Promise.allSettled([
				handle.read(receipt, { onEvent: (chunk) => defaultEvents.push(chunk) }),
				handle.read(receipt, { scope: 'submission', onEvent: (chunk) => scopedEvents.push(chunk) }),
			]);
			expect(scopedEvents).toEqual(expected.chunks);
			const [cloudflareDefault, cloudflareScoped] = await cloudflareReadScopes(
				defaultEvents,
				'target',
			);
			expect(cloudflareDefault.events).toEqual(JSON.parse(JSON.stringify(defaultEvents)));
			expect(cloudflareScoped.events).toEqual(JSON.parse(JSON.stringify(scopedEvents)));
			expect(cloudflareScoped.status).toBe(cloudflareDefault.status);
			expect(cloudflareScoped.reply ?? cloudflareScoped.error).toEqual(
				cloudflareDefault.reply ?? cloudflareDefault.error,
			);
			expect(defaultEvents.length).toBeGreaterThan(scopedEvents.length);
			expect(scoped.status).toBe(ordinary.status);
			if (ordinary.status === 'fulfilled' && scoped.status === 'fulfilled') {
				expect(scoped.value).toEqual(ordinary.value);
				expect(scoped.value).toMatchObject({
					submissionId: 'target',
					uid: 'retained-incarnation',
					data: { proof: [{ durable: true }] },
					metadata: { proof: 'retained' },
				});
			} else {
				if (ordinary.status !== 'rejected' || scoped.status !== 'rejected')
					throw new Error('Read scope proof outcomes differ');
				expect(ordinary.reason).toBeInstanceOf(AgentRunError);
				expect(scoped.reason).toBeInstanceOf(AgentRunError);
				expect(scoped.reason).toMatchObject({
					outcome: ordinary.reason.outcome,
					submissionId: ordinary.reason.submissionId,
					cause: ordinary.reason.cause,
				});
			}
		},
	);

	it('drains every bounded scope page before returning settlement', async () => {
		const { append } = await retainedStream(30);
		await append(
			Array.from({ length: 800 }, (_, index) => ({
				...envelope,
				submissionId: 'later',
				attemptId: 'later',
				type: 'user_message' as const,
				id: `scope_later_${index}`,
				messageId: `entry_scope_later_${index}`,
				parentId: index === 0 ? 'entry_answer' : `entry_scope_later_${index - 1}`,
				content: [{ type: 'text' as const, text: 'Later root input' }],
			})),
			'later',
		);
		const events: ConversationStreamChunk[] = [];
		const reply = await init(StreamProofAgent, { id: 'retained' }).read('target', {
			scope: 'submission',
			onEvent: (chunk) => events.push(chunk),
		});
		expect(events).toHaveLength(816);
		expect(new Set(events.map((chunk) => JSON.stringify(chunk.position))).size).toBe(816);
		expect(reply.text).toBe('0 1 2 3 4 5 6 7 8 9 10 11 ');
		expect(events.at(-1)?.type).toBe('message-appended');
	});

	it('keeps joined replies bound to the answering submission in both read targets', async () => {
		const { store, path, append } = await retainedStream(10, 'stop', false);
		await append(
			[
				{
					...envelope,
					submissionId: 'joined',
					attemptId: 'attempt',
					type: 'user_message',
					id: 'joined_scope_input',
					messageId: 'entry_joined_scope',
					parentId: 'entry_answer',
					content: [{ type: 'text', text: 'Joined steering input' }],
				},
			],
			'joined',
		);
		await append(
			[
				{
					...envelope,
					submissionId: 'target',
					attemptId: 'attempt',
					type: 'submission_settled',
					id: 'scope_host_settled',
					outcome: 'completed',
				},
			],
			'target',
		);
		await append(
			[
				{
					...envelope,
					submissionId: 'joined',
					attemptId: 'attempt',
					type: 'submission_settled',
					id: 'scope_joined_settled',
					outcome: 'completed',
				},
			],
			'joined',
		);
		const expected = await readAgentSubmissionUpdates({ store, path, submissionId: 'joined' });
		expect(expected.settlement).toMatchObject({
			submissionId: 'joined',
			answeredBySubmissionId: 'target',
		});
		const handle = init(StreamProofAgent, { id: 'retained' });
		const ordinaryEvents: ConversationStreamChunk[] = [];
		const scopedEvents: ConversationStreamChunk[] = [];
		const ordinary = await handle.read('joined', {
			onEvent: (chunk) => ordinaryEvents.push(chunk),
		});
		const scoped = await handle.read('joined', {
			scope: 'submission',
			onEvent: (chunk) => scopedEvents.push(chunk),
		});
		expect(scoped).toEqual(ordinary);
		expect(scoped.text).toBe('0 1 2 3 4 5 6 7 8 9 10 11 ');
		expect(scopedEvents).toEqual(expected.chunks);
		expect(scopedEvents.some((chunk) => chunk.type === 'message-delta')).toBe(false);
		const [cloudflareDefault, cloudflareScoped] = await cloudflareReadScopes(
			ordinaryEvents,
			'joined',
		);
		expect(cloudflareScoped.events).toEqual(JSON.parse(JSON.stringify(scopedEvents)));
		expect(cloudflareScoped.reply).toEqual(cloudflareDefault.reply);
		expect(cloudflareScoped.reply).toEqual({ ...scoped, uid: 'retained-incarnation' });
	});

	it('preserves local read cancellation in both scopes', async () => {
		await retainedStream(10, 'stop', false);
		for (const scope of [undefined, 'submission'] as const) {
			const controller = new AbortController();
			const reason = new Error('Read scope proof cancelled locally');
			const handle = init(StreamProofAgent, { id: 'retained' });
			let seen = 0;
			const result = handle.read('target', {
				...(scope ? { scope } : {}),
				signal: controller.signal,
				onEvent: () => {
					seen++;
					controller.abort(reason);
				},
			});
			await expect(result).rejects.toBe(reason);
			expect(seen).toBeGreaterThan(0);
		}
	});

	it('cuts a single large batch at 512 chunks and reconnects at the exact original index', async () => {
		const { store, path, append } = await retainedStream(500);
		const records: ConversationRecord[] = Array.from({ length: 800 }, (_, index) => ({
			...envelope,
			submissionId: 'later',
			attemptId: 'attempt',
			type: 'user_message',
			id: `later_${index}`,
			messageId: `entry_later_${index}`,
			parentId: index === 0 ? 'entry_answer' : `entry_later_${index - 1}`,
			content: [{ type: 'text', text: `steering input ${index}` }],
		}));
		await append(records, 'later');
		const first = await readAgentSubmissionUpdates({ store, path, submissionId: 'target' });
		expect(first.chunks).toHaveLength(512);
		expect(first.truncated).toBe(true);
		expect(first.cursor?.index).toBeLessThan(Number.MAX_SAFE_INTEGER);
		if (first.cursor === undefined) throw new Error('Submission stream cut omitted its cursor');
		const next = await readAgentSubmissionUpdates({
			store,
			path,
			submissionId: 'target',
			after: first.cursor,
		});
		expect(next.chunks).toHaveLength(304);
		expect(next.truncated).toBe(false);
		expect(next.cursor?.index).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			new Set([...first.chunks, ...next.chunks].map((chunk) => JSON.stringify(chunk.position)))
				.size,
		).toBe(816);
		if (next.cursor === undefined) throw new Error('Submission stream resume omitted its cursor');
		const drained = await readAgentSubmissionUpdates({
			store,
			path,
			submissionId: 'target',
			after: next.cursor,
		});
		expect(drained.chunks).toEqual([]);
		expect(drained.truncated).toBe(false);
	});

	it('preserves historical retry resets, tool identities, compaction, joined inputs and helper holes', async () => {
		const { store, path, start, append } = await retainedStream(500, 'error', false);
		const own = { ...envelope, submissionId: 'target', attemptId: 'retry' };
		await append(
			[
				{
					...envelope,
					submissionId: 'joined',
					attemptId: 'joined-attempt',
					type: 'user_message',
					id: 'joined',
					messageId: 'entry_joined',
					parentId: 'entry_answer',
					content: [{ type: 'text', text: 'joined input' }],
				},
			],
			'joined',
		);
		await append(
			[
				{
					...own,
					type: 'assistant_message_started',
					id: 'retry_started',
					messageId: 'entry_retry',
					parentId: 'entry_joined',
					modelInfo: { api: 'openai-completions', provider: 'test', model: 'test' },
				},
				{
					...own,
					type: 'assistant_tool_call',
					id: 'call',
					messageId: 'entry_retry',
					blockId: 'block_call',
					blockIndex: 0,
					toolCallId: 'reused-call',
					name: 'read',
					arguments: { path: 'safe' },
				},
				{
					...own,
					type: 'assistant_message_completed',
					id: 'retry_done',
					messageId: 'entry_retry',
					stopReason: 'toolUse',
					usage,
				},
			],
			'target',
		);
		const taskId = 'task_01J00000000000000000000000';
		const helperSession = createTaskSessionName('default', taskId);
		await append([
			{
				...envelope,
				type: 'conversation_created',
				id: 'helper_born',
				conversationId: 'helper',
				harness: 'default',
				session: helperSession,
				kind: 'task',
				parentConversationId: 'conv',
				taskId,
				affinityKey: 'conv',
				createdAt: envelope.timestamp,
			},
		]);
		await append([
			{
				...envelope,
				conversationId: 'helper',
				session: helperSession,
				type: 'user_message',
				id: 'helper_input',
				messageId: 'entry_helper',
				parentId: null,
				content: [{ type: 'text', text: 'private helper input' }],
			},
		]);
		await append(
			[
				{
					...own,
					type: 'tool_outcome',
					id: 'outcome',
					assistantMessageId: 'entry_retry',
					toolCallId: 'reused-call',
					toolName: 'read',
					isError: false,
					content: [{ type: 'text', text: 'read result' }],
					output: { content: 'read result' },
				},
				{
					...own,
					type: 'tool_results_committed',
					id: 'commit',
					assistantMessageId: 'entry_retry',
					parentId: 'entry_retry',
					outcomeIds: ['outcome'],
				},
			],
			'target',
		);
		const leaf = toolResultEntryId('entry_retry', 'reused-call');
		await append(
			[
				{
					...own,
					type: 'compaction',
					id: 'compact',
					entryId: 'entry_compaction',
					parentId: leaf,
					sourceLeafId: leaf,
					firstKeptEntryId: 'entry_joined',
					summary: 'sanitized summary',
					tokensBefore: 10000,
				},
			],
			'target',
		);
		await append(
			[
				{
					...own,
					type: 'submission_settled',
					id: 'target_aborted',
					outcome: 'aborted',
					error: { type: 'test-stop' },
				},
			],
			'target',
		);
		await append(
			[
				{
					...own,
					type: 'submission_settled',
					id: 'joined_settled',
					submissionId: 'joined',
					outcome: 'aborted',
				},
			],
			'joined',
		);
		const reference = await handleAgentConversationRead({
			store,
			path,
			request: new Request(`http://flue/retained?view=updates&offset=${formatOffset(start - 1)}`),
		});
		expect(reference.ok).toBe(true);
		const expected = ((await reference.json()) as ConversationStreamChunk[]).filter(
			(chunk) =>
				chunk.type !== 'conversation-reset' &&
				chunk.type !== ('stream-checkpoint' as string) &&
				(chunk.type !== 'submission-settled' || chunk.submissionId === 'target'),
		);
		const read = vi.spyOn(store, 'read');
		const result = await readAgentSubmissionUpdates({ store, path, submissionId: 'target' });
		expect(result.chunks).toEqual(expected);
		expect(result.identities).toEqual({
			messageIds: ['entry_answer'],
			toolCallIds: ['reused-call'],
		});
		expect(result.settlement).toMatchObject({ submissionId: 'target', outcome: 'aborted' });
		expect(result.chunks.some((chunk) => chunk.conversationId === 'helper')).toBe(false);
		expect(
			result.chunks.some(
				(chunk) => chunk.type === 'message-appended' && chunk.message.submissionId === 'joined',
			),
		).toBe(true);
		expect(read.mock.calls.filter(([, options]) => options?.offset === '-1')).toEqual([]);
		const ordinaryEvents: ConversationStreamChunk[] = [];
		const scopedEvents: ConversationStreamChunk[] = [];
		const handle = init(StreamProofAgent, { id: 'retained' });
		await expect(
			handle.read('target', { onEvent: (chunk) => ordinaryEvents.push(chunk) }),
		).rejects.toMatchObject({ outcome: 'aborted', submissionId: 'target' });
		await expect(
			handle.read('target', { scope: 'submission', onEvent: (chunk) => scopedEvents.push(chunk) }),
		).rejects.toMatchObject({ outcome: 'aborted', submissionId: 'target' });
		expect(scopedEvents).toEqual(result.chunks);
		const [cloudflareDefault, cloudflareScoped] = await cloudflareReadScopes(
			ordinaryEvents,
			'target',
		);
		expect(cloudflareScoped.events).toEqual(JSON.parse(JSON.stringify(scopedEvents)));
		expect(cloudflareScoped.error).toEqual(cloudflareDefault.error);
	});

	it.each([0, 500, 5000])(
		'keeps exact chunk positions without replaying %i prior batches',
		async (length) => {
			const { store, path, start } = await retainedStream(length);
			const baseline = await handleAgentConversationRead({
				store,
				path,
				request: new Request(`http://flue/retained?view=updates&offset=${formatOffset(start - 1)}`),
			});
			expect(baseline.ok).toBe(true);
			const expected = (
				(await baseline.json()) as Array<ConversationStreamChunk | { type: 'stream-checkpoint' }>
			).filter((chunk) => chunk.type !== 'stream-checkpoint');
			const read = vi.spyOn(store, 'read');
			const result = await readAgentSubmissionUpdates({ store, path, submissionId: 'target' });
			expect(result.chunks).toEqual(expected);
			expect(result.identities).toEqual({ messageIds: ['entry_answer'], toolCallIds: [] });
			expect(result.settlement).toMatchObject({ submissionId: 'target', outcome: 'completed' });
			expect(
				read.mock.calls.every(([, options]) => parseOffset(options?.offset ?? '-1') >= start - 1),
			).toBe(true);
			expect(read.mock.calls.length).toBeLessThanOrEqual(2);
		},
	);

	it('rebuilds an old retained checkpoint once and resumes cold from its replacement', async () => {
		const { store, path, start } = await retainedStream(5000);
		await readAgentSubmissionUpdates({ store, path, submissionId: 'target' });
		const checkpoint = await store.getFoldCheckpoint(path);
		if (checkpoint === null)
			throw new Error('Submission stream proof did not retain its checkpoint');
		const encoded = JSON.parse(checkpoint.data);
		delete encoded.submissionStreams;
		delete encoded.resetOffsets;
		const meta = await store.getMeta(path);
		if (meta === null) throw new Error('Submission stream proof lost its stream metadata');
		await store.putFoldCheckpoint(path, {
			offset: checkpoint.offset,
			incarnation: meta.incarnation,
			formatVersion: 5,
			data: JSON.stringify(encoded),
		});
		const coldStore = () => ({
			createStream: store.createStream.bind(store),
			acquireProducer: store.acquireProducer.bind(store),
			append: store.append.bind(store),
			read: store.read.bind(store),
			getMeta: store.getMeta.bind(store),
			subscribe: store.subscribe.bind(store),
			getFoldCheckpoint: store.getFoldCheckpoint.bind(store),
			putFoldCheckpoint: store.putFoldCheckpoint.bind(store),
		});
		const cold = coldStore();
		const read = vi.spyOn(cold, 'read');
		const result = await readAgentSubmissionUpdates({ store: cold, path, submissionId: 'target' });
		expect(result.chunks.some((chunk) => chunk.type === 'message-delta')).toBe(true);
		expect(read.mock.calls.some(([, options]) => options?.offset === '-1')).toBe(true);
		await expect.poll(async () => (await store.getFoldCheckpoint(path))?.formatVersion).toBe(6);
		read.mockClear();
		await readAgentSubmissionUpdates({ store: cold, path, submissionId: 'target' });
		expect(
			read.mock.calls.every(([, options]) => parseOffset(options?.offset ?? '-1') >= start - 1),
		).toBe(true);
		const nextCold = coldStore();
		const nextRead = vi.spyOn(nextCold, 'read');
		expect(
			(await readAgentSubmissionUpdates({ store: nextCold, path, submissionId: 'target' })).chunks,
		).toEqual(result.chunks);
		expect(
			nextRead.mock.calls.every(([, options]) => parseOffset(options?.offset ?? '-1') >= start - 1),
		).toBe(true);
	});

	it('restores durable identities discarded from the materialized path by cancellation', async () => {
		const { store, path, start } = await retainedStream(500, 'aborted');
		const first = await readAgentSubmissionUpdates({
			store,
			path,
			submissionId: 'target',
			batchLimit: 5,
		});
		expect(first.identities.messageIds).toEqual(['entry_answer']);
		expect(first.truncated).toBe(true);
		if (first.cursor === undefined) throw new Error('Cancelled stream cut omitted its cursor');
		const next = await readAgentSubmissionUpdates({
			store,
			path,
			submissionId: 'target',
			after: first.cursor,
		});
		const reference = await handleAgentConversationRead({
			store,
			path,
			request: new Request(`http://flue/retained?view=updates&offset=${formatOffset(start - 1)}`),
		});
		const expected = (
			(await reference.json()) as Array<ConversationStreamChunk | { type: 'stream-checkpoint' }>
		).filter((chunk) => chunk.type !== 'stream-checkpoint');
		expect([...first.chunks, ...next.chunks]).toEqual(expected);
		expect(next.identities.messageIds).toEqual(['entry_answer']);
		expect(next.settlement).toMatchObject({ outcome: 'aborted', error: { type: 'stop' } });
	});
});
