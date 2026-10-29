import { PGlite } from '@electric-sql/pglite';
import {
	defineAttachmentStoreContractTests,
	defineConversationStreamStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import { postgres, type PostgresQuery } from './index.ts';

const databases: PGlite[] = [];
async function createStores() {
	const db = new PGlite();
	databases.push(db);
	const query: PostgresQuery = async (sql, params) =>
		(await db.query<Record<string, unknown>>(sql, params)).rows;
	const adapter = postgres({
		query,
		transaction: (run) =>
			db.transaction((tx) =>
				run({
					query: async (sql, params) => (await tx.query<Record<string, unknown>>(sql, params)).rows,
				}),
			),
		close: () => db.close(),
	});
	if (adapter.migrate === undefined) throw new Error('Postgres adapter migration is missing');
	await adapter.migrate();
	return adapter.connect();
}
async function cleanup() {
	await Promise.all(databases.splice(0).map((db) => db.close()));
}

defineStoreContractTests('Postgres submission persistence', {
	create: async () => (await createStores()).submissionStore,
	cleanup,
});
defineConversationStreamStoreContractTests('Postgres conversation persistence', {
	async create() {
		const stores = await createStores();
		return { stream: stores.conversationStreamStore, submissionStore: stores.submissionStore };
	},
	cleanup,
});
defineAttachmentStoreContractTests('Postgres attachment persistence', {
	create: async () => (await createStores()).attachmentStore,
	cleanup,
});
