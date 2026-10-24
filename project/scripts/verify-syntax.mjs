import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = ['extension', 'scripts', 'tests'];
const sourceExtensions = new Set(['.js', '.mjs']);

function collectFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...collectFiles(fullPath));
        else if (
            sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))
        )
            files.push(fullPath);
    }
    return files;
}

const files = sourceRoots
    .flatMap((root) => collectFiles(join(projectRoot, root)))
    .sort((left, right) =>
        relative(projectRoot, left).localeCompare(relative(projectRoot, right)),
    );

const failures = [];
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        failures.push({
            file: relative(projectRoot, file).replaceAll('\\', '/'),
            output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
        });
    }
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`verify-syntax failed: ${failure.file}`);
        if (failure.output) console.error(failure.output);
    }
    process.exitCode = 1;
} else {
    console.log(`verify-syntax OK: ${files.length} files`);
}
