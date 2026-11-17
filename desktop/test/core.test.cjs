const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {serverURL, pageURL, sameOrigin, localConfig, compareVersions, installedPluginVersion, setLanListen, extractZipBuffer} = require('../core.cjs');
test('only explicit server origins; credentials never persist in URL', () => {
  assert.equal(serverURL(' http://127.0.0.1:8000/ '), 'http://127.0.0.1:8000');
  for (const url of ['javascript:alert(1)', 'file:///C:/data', 'example.com', 'https://user:pass@host', 'https://host/path', 'https://host/?token=a', 'https://host/#abc']) assert.throws(() => serverURL(url));
});
test('routes stay on selected server and origin checks include scheme/port', () => {
  assert.equal(pageURL('https://example.org', 'catalog'), 'https://example.org/api/plugins/korrektor/app/#tools/catalog');
  assert.throws(() => pageURL('https://example.org', '__proto__'));
  assert.ok(sameOrigin('https://example.org:443/chat', 'https://example.org'));
  for (const url of ['http://example.org', 'https://example.org:444', 'https://example.org.evil/', 'file:///a']) assert.equal(sameOrigin(url, 'https://example.org'), false);
});
test('local launcher respects configured port and refuses unsupported installs', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tavernka-'));
  try {
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({name:'SillyTavern'}));
    fs.writeFileSync(path.join(folder, 'server.js'), '');
    fs.writeFileSync(path.join(folder, 'config.yaml'), 'port: 8123\ndataRoot: ./data\n');
    assert.equal(localConfig(folder).url, 'http://127.0.0.1:8123');
    fs.writeFileSync(path.join(folder, 'config.yaml'), 'port: 70000');
    assert.throws(() => localConfig(folder));
    fs.writeFileSync(path.join(folder, 'config.yaml'), 'dataRoot: ../private');
    assert.throws(() => localConfig(folder));
    fs.writeFileSync(path.join(folder, 'config.yaml'), 'ssl:\n  enabled: true');
    assert.throws(() => localConfig(folder));
  } finally { fs.rmSync(folder, {recursive:true, force:true}); }
});

test('version comparison, LAN toggle and pure-Node ZIP extraction for auto-install preserve user data', async () => {
  const {buildZipBuffer} = await import('../../plugin/lib/tavern-manage.mjs');
  assert.equal(compareVersions('0.4.30', '0.4.29'), 1);
  assert.equal(compareVersions('0.4.30', '0.4.30'), 0);
  assert.equal(compareVersions('0.4.9', '0.4.30'), -1);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tavernka-zip-'));
  try {
    fs.mkdirSync(path.join(folder, 'data'), {recursive: true});
    fs.writeFileSync(path.join(folder, 'data', 'keep.txt'), 'user-chat');
    const zip = buildZipBuffer([
      {name: 'SillyTavern-release/package.json', data: Buffer.from(JSON.stringify({name: 'SillyTavern'}))},
      {name: 'SillyTavern-release/server.js', data: Buffer.from('// server')},
      {name: 'SillyTavern-release/default/config.yaml', data: Buffer.from('port: 8000\nlisten: false\n')},
      {name: 'SillyTavern-release/data/keep.txt', data: Buffer.from('overwrite-attempt')},
    ]);
    extractZipBuffer(zip, folder, {stripTopDir: true, preserveTop: ['data', 'config.yaml']});
    assert.equal(fs.readFileSync(path.join(folder, 'data', 'keep.txt'), 'utf8'), 'user-chat');
    assert.equal(localConfig(folder).listen, false);
    assert.equal(setLanListen(folder, true).listen, true);
    assert.equal(installedPluginVersion(folder), '');
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
  }
});

