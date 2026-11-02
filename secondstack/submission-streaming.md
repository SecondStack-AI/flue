# Submission streaming

The full-conversation observer reconstructs the prefix before its requested offset.
Repeated reads for a recent submission therefore grow with retained conversation history.
The fork provides bounded submission reads for delivery and settlement while preserving the existing full-conversation API.

## Public APIs

```ts
import { init } from '@flue/runtime';
import { readAgentSubmissionUpdates } from '@flue/runtime/routing';

const reply = await init(MyAgent, { id: conversationId }).read(receipt, {
  scope: 'submission',
  onEvent: deliverChunk,
  signal,
});

const page = await readAgentSubmissionUpdates({
  store: conversationStreamStore,
  path: streamPath,
  submissionId: receipt.submissionId,
  after: previousCursor,
});
```

The page contains `chunks`, an optional `cursor`, `truncated`, durable message/tool `identities`, and an optional `settlement`.
Consumers resume from `cursor` until `truncated` is false; settlement alone does not mean all pages were delivered.
The default page scans at most 100 batches and 512 projected chunks.
Positions retain the full router's `{ batch, index }` coordinates, including gaps for excluded chunks.
`Number.MAX_SAFE_INTEGER` denotes a fully consumed batch; partial-batch cursors resume after the exact projected chunk.
An unknown submission returns an empty page; the client observation continues waiting for admitted work to appear.
These are trusted store reads, not an authorization boundary: the embedding application must validate receipt, tenant and conversation ownership before calling them.

Submission scope includes that submission's assistant and tool events and subsequent root user messages needed to show steering.
It omits conversation-reset snapshots, unrelated assistant responses and helper conversations.
It preserves original chunk bodies and positions rather than rebuilding a second UI protocol.
Joined submissions retain the existing answering-submission linkage when resolving the final reply.
Errors, data, metadata, incarnation UID and local read cancellation retain their default semantics.
An unsignalled read still waits for settlement; cancelling the observation does not abort durable work.

Node's scoped settlement observer drains the bounded pages and then uses the existing durable wait primitive.
Cloudflare filters the same events from its existing transport, without a new route or reduced history traversal cost.
Omitting `scope` leaves the default observer unchanged on both targets.

## Persistence

The existing canonical fold records each submission's first offset, historical response identity transitions, message/tool identities and reset positions.
Ordinary batch projection reuses the existing encoder with the response identities valid at that batch.
Reset batches need no historical prefix replay because their identities are already indexed and submission scope does not emit their snapshots.
The writer supplies the new batch's offset when advancing this index.

The index is stored in the existing disposable fold checkpoint; there is no new database table, transcript copy or authoritative cache.
Checkpoint format changes from 5 to 6. A cold reader rebuilds an old checkpoint once from unchanged canonical records and writes its replacement.
Older readers can rebuild an unsupported checkpoint from those same records; alternating versions may repeat this work.
The canonical record format and adapter schema do not change.
Index maintenance and full checkpoint rebuilds add CPU and checkpoint bytes; they are not free or constant in history size.

## Flush cadence

Queued mid-block deltas flush within 250 ms instead of one second; block boundaries and completion still flush immediately.
Durability ordering, producer fencing and idempotent append semantics are unchanged.
The timer exists only while records are queued, so idle conversations add no timer polling.
More frequent batches increase active-stream database writes; consumers should measure this cost with their adapters and workload.

## Verification and release

`packages/runtime/tests/submission-updates.test.ts` compares scoped reads with the existing full router, including long histories, exact partial-page resumes, retry resets, compaction, tools, helpers, joined inputs, cancellation, and old checkpoints.
It also compares Node and Cloudflare reply/event/error behavior.
`conversation-writer-streaming.test.ts` verifies batch-offset indexing and a queued tail becoming durable before provider completion.
The PostgreSQL adapter's existing store contract suite runs against the native build.
SecondStack retains separate installed-package, real PostgreSQL owner, websocket and browser acceptance tests.

The normal `secondstack-v2.3.0-secondstack.N` release builds the source and publishes matching runtime/adapter packages with commit and Actions provenance.
No bundle rewriting or consumer patch-generation step is used.
