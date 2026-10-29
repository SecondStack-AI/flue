import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!/^2\.3\.0-secondstack\.[1-9]\d*$/.test(version ?? '')) {
	throw new Error('SecondStack package version must be 2.3.0-secondstack.N');
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const upstreamCommit = 'deee93b40d275ecc9a50c50af2158f20089d54bc';
const destination = resolve('dist/secondstack-packages');
await mkdir(destination, { recursive: true });
for (const component of ['runtime', 'postgres']) {
	const source = resolve(`packages/${component}`);
	const target = resolve(destination, component);
	const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
	await mkdir(target, { recursive: true });
	for (const entry of component === 'runtime' ? ['dist', 'types'] : ['dist']) {
		await cp(resolve(source, entry), resolve(target, entry), { recursive: true });
	}
	await cp('LICENSE', resolve(target, 'LICENSE'));
	manifest.name = `@secondstack-ai/flue-${component}`;
	manifest.version = version;
	manifest.repository.url = 'https://github.com/SecondStack-AI/flue.git';
	manifest.publishConfig = { registry: 'https://npm.pkg.github.com' };
	manifest.files =
		component === 'runtime'
			? ['dist', 'types', 'LICENSE', 'provenance.json']
			: ['dist', 'LICENSE', 'provenance.json'];
	delete manifest.devDependencies;
	delete manifest.scripts;
	if (component === 'postgres') {
		manifest.dependencies['@flue/runtime'] = `npm:@secondstack-ai/flue-runtime@${version}`;
	}
	await writeFile(resolve(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(
		resolve(target, 'provenance.json'),
		`${JSON.stringify(
			{
				sourceRepository: manifest.repository.url,
				sourceCommit,
				upstreamCommit,
				version,
				buildRun: process.env.GITHUB_RUN_ID ?? null,
			},
			null,
			2,
		)}\n`,
	);
}
console.log(`Prepared ${version} from ${sourceCommit} in ${destination}`);
