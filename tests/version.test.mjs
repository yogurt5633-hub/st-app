import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('app, plugin, service worker and companion carry the same version', () => {
    const plugin = JSON.parse(read('plugin/package.json')).version;
    const app = read('plugin/app/app.js').match(/const APP_VERSION = '([^']+)'/)[1];
    const sw = read('plugin/app/sw.js').match(/korrektor-([0-9.]+)/)[1];
    const ext = JSON.parse(read('st-extension/manifest.json')).version;
    const companion = read('st-extension/translate.js').match(/const COMPANION_VERSION = '([^']+)'/)[1];
    assert.deepEqual([app, sw, ext, companion], [plugin, plugin, plugin, plugin]);
});
