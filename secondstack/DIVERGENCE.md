# SecondStack Flue fork

Maintainer: Dmitriy Alergant for SecondStack-AI.
Upstream base: `withastro/flue` 2.3.0, `deee93b40d275ecc9a50c50af2158f20089d54bc`.
The Apache-2.0 license and upstream history are retained.

| Change                                                           | Validation                                                                     | Return upstream when                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Persist exact tool declarations and their entry positions (#882) | Runtime replay and checkpoint tests; SecondStack native tool-cache acceptance  | Upstream reads the persisted declarations without rewriting their historical positions |
| Accurate workspace attach/detach/replacement signals (#883)      | Runtime workspace transition tests                                             | Upstream carries equivalent transition messages                                        |
| Optional generated environment preamble (#884)                   | Runtime prompt tests; SecondStack instruction inventory                        | Upstream provides a supported opt-out                                                  |
| Compaction with unchanged recent groups and manual entry (#887)  | Runtime compaction tests; SecondStack provider, billing and command acceptance | Upstream supports the same persistent compaction contract                              |
| Exact dependency pins and organization packages                  | Registry publication-date audit; CI package build and clean consumer install   | Upstream release replaces the fork without a dependency or persistence incompatibility |

## Release contract

A `secondstack-v2.3.0-secondstack.N` tag builds and validates runtime and PostgreSQL adapter packages in Actions.
Only Actions publishes `@secondstack-ai/flue-runtime` and `@secondstack-ai/flue-postgres` with its repository-scoped `GITHUB_TOKEN`.
Package tarballs contain their source commit, upstream commit and Actions run id in `provenance.json`; Actions retains npm integrity output with the tarballs.
Package source names remain upstream-compatible; publication stages the organization names without changing imports.
The adapter depends on the exact runtime version under the `@flue/runtime` alias, and SecondStack uses that same alias and version.
This permits one runtime implementation for public, internal and adapter imports.

Outside Actions, registry reads require an approved `read:packages` token through a secret-mounted npm configuration.
Credentials must never enter package archives, lockfiles or image layers.
Grant the SecondStack repository Actions read access to both packages before adopting a version.

## Persistence and rollback

Pause new admissions and finish active work before replacing shard owners.
The fork reads version-1 and version-2 records, writes version-2 records, and preserves old streams through a current-tool baseline.
Upstream version-1 readers reject newly written streams.
Missing historical declarations cannot be reconstructed.
Returning to upstream requires a compatible reader or a separately reviewed offline conversion with a backup and tested restore.
An old image alone is not a rollback plan.

Existing summary text is rendered as plain text instead of XML-escaped text, causing a one-time prefix change for old compacted streams.
The fit contract requires positive model context and output limits; unknown limits fail rather than use upstream fallback estimates.
Direct instance dispatch during compaction returns `SessionBusyError`; callers that schedule non-Chat work must retry this busy result.
