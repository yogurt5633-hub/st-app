import fs from 'node:fs/promises';
import path from 'node:path';

const RULES = [
    ['dynamic-code', /\beval\s*\(|\bnew\s+Function\s*\(/g, 'Выполнение кода из строки'],
    ['process', /(?:node:)?child_process|\bexecSync\s*\(|\bspawnSync\s*\(/g, 'Запуск системных команд'],
    ['encoded-code', /(?:eval|Function)\s*\([^\n]{0,120}(?:atob|fromCharCode)/g, 'Выполнение закодированного текста'],
    ['remote-code', /\bimport\s*\(\s*['"]https?:\/\//g, 'Загрузка исполняемого кода с другого сайта'],
];

export function reviewSource(source, file) {
    const findings = [];
    for (const [rule, pattern, label] of RULES) {
        pattern.lastIndex = 0;
        const match = pattern.exec(source);
        if (match) findings.push({ rule, label, file, line: source.slice(0, match.index).split('\n').length });
    }
    return findings;
}

/** Read local files only. Symlinks and large/generated dependency trees are skipped. */
export async function reviewExtensions(roots) {
    const items = [];
    for (const root of new Set(roots.map(root => path.resolve(root)))) {
        let extensions;
        try { extensions = await fs.readdir(root, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const entry of extensions) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isSymbolicLink()) { items.push({ name: entry.name, files: 0, findings: [], complete: false }); continue; }
            if (!entry.isDirectory()) continue;
            const item = { name: entry.name, files: 0, findings: [], complete: true };
            const base = path.join(root, entry.name);
            let bytes = 0;
            async function walk(dir, depth) {
                if (depth > 6) { item.complete = false; return; }
                for (const file of await fs.readdir(dir, { withFileTypes: true })) {
                    if (file.name.startsWith('.') || file.name === 'node_modules') { item.complete = false; continue; }
                    const full = path.join(dir, file.name);
                    if (file.isDirectory()) { await walk(full, depth + 1); continue; }
                    if (!file.isFile()) { item.complete = false; continue; }
                    if (!/\.(?:js|mjs|cjs|jsx|ts|tsx|html)$/i.test(file.name)) continue;
                    const stat = await fs.stat(full);
                    if (stat.size > 2000000 || bytes + stat.size > 10000000 || item.files >= 500) { item.complete = false; continue; }
                    bytes += stat.size;
                    item.files++;
                    const source = await fs.readFile(full, 'utf8');
                    item.findings.push(...reviewSource(source, path.relative(base, full)));
                }
            }
            try { await walk(base, 0); }
            catch { item.complete = false; }
            items.push(item);
        }
    }
    return { items, checkedAt: new Date().toISOString() };
}
