#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const SECRET_PATTERNS = [
    {
        name: 'Supabase PAT',
        regex: /\bsbp_[A-Za-z0-9]{24,}\b/g,
    },
    {
        name: 'OpenAI project key',
        regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        name: 'Layerinfinite API key',
        regex: /\blayerinfinite_[A-Za-z0-9]{24,}\b/g,
    },
];

const IGNORE_FILE_PARTS = [
    'node_modules/',
    '.venv/',
    'dist/',
    '.git/',
    '.next/',
];

const IGNORE_LINE_HINTS = [
    'example',
    'replace',
    'placeholder',
    'testkey',
    'dummy',
    'xxxx',
    'YOUR_',
    'your_',
    '***',
];

function listTrackedFiles() {
    const out = cp.execSync('git ls-files', { encoding: 'utf8' });
    return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((file) => !IGNORE_FILE_PARTS.some((part) => file.includes(part)));
}

function shouldIgnoreLine(line) {
    const lower = line.toLowerCase();
    return IGNORE_LINE_HINTS.some((hint) => lower.includes(String(hint).toLowerCase()));
}

function scanFile(filePath) {
    const absolutePath = path.resolve(filePath);
    let content;
    try {
        content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
        return [];
    }

    const findings = [];
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
        if (shouldIgnoreLine(line)) return;

        for (const pattern of SECRET_PATTERNS) {
            pattern.regex.lastIndex = 0;
            const match = pattern.regex.exec(line);
            if (match) {
                findings.push({
                    filePath,
                    line: index + 1,
                    pattern: pattern.name,
                    snippet: line.trim().slice(0, 160),
                });
            }
        }
    });

    return findings;
}

function main() {
    const files = listTrackedFiles();
    const findings = [];

    for (const file of files) {
        findings.push(...scanFile(file));
    }

    if (findings.length) {
        console.error('Tracked-secret scan failed. Potential hardcoded secrets found:');
        for (const finding of findings) {
            console.error(`- ${finding.filePath}:${finding.line} [${finding.pattern}] ${finding.snippet}`);
        }
        process.exit(1);
    }

    console.log('Tracked-secret scan passed.');
}

main();
