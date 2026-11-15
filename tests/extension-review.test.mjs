import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewSource, reviewExtensions } from '../plugin/lib/extension-review.mjs';

test('extension review reports code location without exposing source or treating ordinary fetch as malware', () => {
    assert.deepEqual(reviewSource('fetch("https://example.com")', 'index.js'), []);
    const findings = reviewSource('// comment\neval(atob(payload))', 'index.js');
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].file, 'index.js');
    assert.ok(findings.some(item => item.rule === 'encoded-code'));
});

test('extension review skips symlinks and marks incomplete coverage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernka-extensions-'));
    try {
        await fs.mkdir(path.join(root, 'extension'));
        await fs.writeFile(path.join(root, 'extension', 'index.js'), 'eval(code)');
        await fs.symlink('/etc/passwd', path.join(root, 'extension', 'outside.js'));
        const report = await reviewExtensions([root]);
        assert.equal(report.items[0].files, 1);
        assert.equal(report.items[0].complete, false);
        assert.equal(report.items[0].findings.length, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('extension review identifies skipped extension links and deduplicates roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernka-extensions-'));
    try {
        await fs.symlink('/does-not-exist', path.join(root, 'linked-extension'));
        const report = await reviewExtensions([root, root + '/']);
        assert.equal(report.items.length, 1);
        assert.equal(report.items[0].complete, false);
        assert.equal(report.items[0].files, 0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
