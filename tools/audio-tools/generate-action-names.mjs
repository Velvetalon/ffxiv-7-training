import { readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('../../src/combat/data.js', import.meta.url), 'utf8');
const names = new Set();
const pattern = /(?:spell|weapon|ability)\(\s*(['"])(?:\\.|(?!\1).)*\1\s*,\s*(['"])((?:\\.|(?!\2).)*)\2\s*,/g;
for (const match of source.matchAll(pattern)) names.add(match[3].replaceAll('\\\\\'', "'").replaceAll('\\\\\"', '"'));
const output = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans'));
await writeFile(new URL('./action-names.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ names: output.length, output: 'tools/audio-tools/action-names.json' }));
