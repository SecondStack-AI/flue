import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { afterEach, expect, it, vi } from 'vitest';
import { init } from '../src/agent-client.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import { start } from '../src/node/start.ts';

function TakeoverAgent() {
	useModel('takeover-test/fixture');
	return 'Answer the user.';
}

afterEach(() => vi.useRealTimers());

it.each([
	{ mode: 'with an external fence', options: { reclaimLeasesOnStartup: true } },
	{ mode: 'by default', options: {} },
])('recovers interrupted work $mode', async ({ options }) => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
	vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));

	const sqliteAdapter = sqlite();
	try {
		await sqliteAdapter.migrate?.();
		const { submissionStore, conversationStreamStore, attachmentStore } =
			await sqliteAdapter.connect();
		// Each runtime stops independently while the database retains the interrupted attempt.
		const db = { connect: () => ({ submissionStore, conversationStreamStore, attachmentStore }) };
		const provider = fauxProvider({
			provider: 'takeover-test',
			models: [{ id: 'fixture' }],
			tokensPerSecond: 0,
		});
		const firstTurn = Promise.withResolvers<void>();
		provider.setResponses([
			(_context, request) => {
				const signal = request?.signal;
				if (!signal) throw new Error('Expected the first turn to be abortable');
				return new Promise((resolve) => {
					signal.addEventListener(
						'abort',
						() => resolve(fauxAssistantMessage('', { stopReason: 'aborted' })),
						{ once: true },
					);
					firstTurn.resolve();
				});
			},
		]);
		const startOptions = { agents: [TakeoverAgent], db, providers: [provider.provider] };
		const agent = init(TakeoverAgent, { id: 'interrupted' });
		const receipt = await (async () => {
			await using _predecessor = await start(startOptions);
			const receipt = await agent.dispatch('Please finish this turn.');
			await firstTurn.promise;
			return receipt;
		})();

		const { submissionId } = receipt;
		const path = 'agents/TakeoverAgent/interrupted';
		const interrupted = await submissionStore.getSubmission(submissionId);
		const oldProducer = await conversationStreamStore.getMeta(path);
		if (!interrupted?.attemptId || !oldProducer?.producerId)
			throw new Error('Expected a retained attempt and stream producer');
		expect(interrupted).toMatchObject({ status: 'running', attemptCount: 1 });
		expect(interrupted.leaseExpiresAt).toBeGreaterThan(Date.now());

		const resumedAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
		provider.setResponses([() => resumedAnswer.promise]);
		await using _replacement = await start({ ...startOptions, ...options });
		try {
			if (!options.reclaimLeasesOnStartup) {
				expect(await submissionStore.getSubmission(submissionId)).toEqual(interrupted);
				await vi.advanceTimersByTimeAsync(interrupted.leaseExpiresAt - Date.now());
				expect(await submissionStore.getSubmission(submissionId)).toEqual(interrupted);
				await vi.advanceTimersByTimeAsync(15_000);
			}

			if (options.reclaimLeasesOnStartup) {
				expect(Date.now()).toBeLessThan(interrupted.leaseExpiresAt);
			}
			const resumed = await submissionStore.getSubmission(submissionId);
			expect(resumed).toMatchObject({ status: 'running', attemptCount: 2 });
			expect(resumed?.ownerId).not.toBe(interrupted.ownerId);
			expect(resumed?.attemptId).not.toBe(interrupted.attemptId);

			const staleAttempt = { submissionId, attemptId: interrupted.attemptId };
			expect(await submissionStore.requeueSubmission(staleAttempt)).toBe(false);
			const stream = await conversationStreamStore.read(path);
			const userMessage = stream.batches
				.flatMap((batch) => batch.records)
				.find((record) => record.type === 'user_message');
			if (!userMessage) throw new Error('Expected the original durable input');
			await expect(
				conversationStreamStore.append({
					path,
					producerId: oldProducer.producerId,
					producerEpoch: oldProducer.producerEpoch,
					incarnation: oldProducer.incarnation,
					producerSequence: oldProducer.nextProducerSequence,
					submission: staleAttempt,
					records: [userMessage],
				}),
			).rejects.toMatchObject({
				name: 'ConversationStreamStoreError',
				meta: { reason: 'Producer ownership is stale.' },
			});
		} finally {
			resumedAnswer.resolve(fauxAssistantMessage('Recovered answer'));
		}
		expect((await agent.read(receipt)).text).toBe('Recovered answer');
	} finally {
		await sqliteAdapter.close?.();
	}
});
