// Word-level diff (Myers) for the proofreading view.
// Returns [[type, text], ...] where type is -1 (removed), 0 (same), 1 (added).

const WORDS = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu;
const SENTENCES = /[^.!?…\n]+[.!?…]*["»”)]*\s*|\n+|[.!?…]+\s*/g;

function tokenize(text, re) {
    const value = String(text ?? '');
    const tokens = value.match(re) ?? [];
    // Never lose characters: if the pattern skipped something, treat the text as one token.
    return tokens.join('') === value ? tokens : [value];
}

function myers(a, b, maxD) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= max; d++) {
        if (d > maxD) return null;
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b);
        }
    }
    return null;
}

function backtrack(trace, a, b) {
    const out = [];
    let x = a.length;
    let y = b.length;
    for (let d = trace.length - 1; d >= 0; d--) {
        const w = trace[d];
        const at = (k) => w[k + d + 1];
        const k = x - y;
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            out.push([0, a[x - 1]]);
            x--;
            y--;
        }
        if (d > 0) {
            if (x === prevX) out.push([1, b[prevY]]);
            else out.push([-1, a[prevX]]);
        }
        x = prevX;
        y = prevY;
    }
    return out.reverse();
}

function diffTokens(a, b, maxD) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const middleA = a.slice(start, endA);
    const middleB = b.slice(start, endB);
    let middle;
    if (!middleA.length) middle = middleB.map(t => [1, t]);
    else if (!middleB.length) middle = middleA.map(t => [-1, t]);
    else if (middleA.length + middleB.length > 12000) return null;
    else middle = myers(middleA, middleB, maxD);
    if (!middle) return null;
    return [...a.slice(0, start).map(t => [0, t]), ...middle, ...a.slice(endA).map(t => [0, t])];
}

function glue(parts) {
    const out = [];
    for (const [type, text] of parts) {
        const last = out[out.length - 1];
        if (last && last[0] === type) last[1] += text;
        else out.push([type, text]);
    }
    return out;
}

/**
 * Changes separated only by spaces become one removed block and one added
 * block: "old words" -> "new words" reads better than word-by-word stripes.
 */
function merge(parts) {
    const glued = glue(parts);
    const out = [];
    let i = 0;
    while (i < glued.length) {
        if (glued[i][0] === 0) {
            out.push(glued[i]);
            i++;
            continue;
        }
        let del = '';
        let ins = '';
        let j = i;
        while (j < glued.length) {
            const [type, text] = glued[j];
            if (type === -1) del += text;
            else if (type === 1) ins += text;
            else if (/^\s+$/.test(text) && j + 1 < glued.length && glued[j + 1][0] !== 0) {
                del += text;
                ins += text;
            } else break;
            j++;
        }
        if (del) out.push([-1, del]);
        if (ins) out.push([1, ins]);
        i = j;
    }
    return out;
}

export function diffWords(before, after) {
    const a = String(before ?? '');
    const b = String(after ?? '');
    if (a === b) return a ? [[0, a]] : [];
    let parts = diffTokens(tokenize(a, WORDS), tokenize(b, WORDS), 1500);
    if (!parts) parts = diffTokens(tokenize(a, SENTENCES), tokenize(b, SENTENCES), 3000);
    if (!parts) parts = [[-1, a], [1, b]];
    return merge(parts);
}
