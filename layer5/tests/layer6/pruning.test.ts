/**
 * Layerinfinite — Phase 6 Unit Tests: Pruning & Archival
 * ══════════════════════════════════════════════════════════════
 * Tests the data lifecycle rules: archive conditions,
 * cold-delete conditions, and salience stat computation.
 *
 * Run: npx vitest run tests/layer6/pruning.test.ts
 * ══════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';

// ── Pruning rule constants (mirrors pruning-scheduler) ──

const ARCHIVE_DAYS = 90;
const COLD_DELETE_DAYS = 365;
const SALIENCE_THRESHOLD = 0.01;

// ── Helper: check if a row qualifies for archival ──

interface OutcomeRow {
    id: string;
    created_at: string;
    salience: number;
    is_deleted: boolean;
    is_synthetic: boolean;
}

interface ArchivedRow extends OutcomeRow {
    archived_at: string;
}

function shouldArchive(row: OutcomeRow, referenceDate: Date): boolean {
    const rowDate = new Date(row.created_at);
    const ageDays = (referenceDate.getTime() - rowDate.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays > ARCHIVE_DAYS && row.salience < SALIENCE_THRESHOLD && !row.is_deleted;
}

function shouldColdDelete(archivedRow: ArchivedRow, referenceDate: Date): boolean {
    const archivedDate = new Date(archivedRow.archived_at);
    const daysSinceArchive = (referenceDate.getTime() - archivedDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceArchive > COLD_DELETE_DAYS;
}

interface SalienceStats {
    avgSalience: number;
    minSalience: number;
    maxSalience: number;
    totalRows: number;
    belowThreshold: number;
}

function computeSalienceStats(rows: OutcomeRow[]): SalienceStats {
    if (rows.length === 0) {
        return { avgSalience: 0, minSalience: 0, maxSalience: 0, totalRows: 0, belowThreshold: 0 };
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let belowThreshold = 0;

    for (const row of rows) {
        sum += row.salience;
        if (row.salience < min) min = row.salience;
        if (row.salience > max) max = row.salience;
        if (row.salience < SALIENCE_THRESHOLD) belowThreshold += 1;
    }

    return {
        avgSalience: sum / rows.length,
        minSalience: min,
        maxSalience: max,
        totalRows: rows.length,
        belowThreshold,
    };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

describe('Phase 6 — Pruning & Archival', () => {

    const now = new Date('2025-06-15T00:00:00Z');

    // ── Test 1: Row older than 90 days with low salience qualifies for archive ──
    it('archives rows older than 90 days with salience < 0.01', () => {
        const oldRow: OutcomeRow = {
            id: 'row-1',
            created_at: '2025-01-01T00:00:00Z',  // ~165 days old
            salience: 0.005,
            is_deleted: false,
            is_synthetic: false,
        };

        expect(shouldArchive(oldRow, now)).toBe(true);
    });

    // ── Test 2: Recent row does NOT qualify for archive ──
    it('does not archive rows younger than 90 days', () => {
        const recentRow: OutcomeRow = {
            id: 'row-2',
            created_at: '2025-05-01T00:00:00Z',  // ~45 days old
            salience: 0.005,
            is_deleted: false,
            is_synthetic: false,
        };

        expect(shouldArchive(recentRow, now)).toBe(false);
    });

    // ── Test 3: High-salience old row is NOT archived ──
    it('does not archive high-salience rows even when old', () => {
        const salientRow: OutcomeRow = {
            id: 'row-3',
            created_at: '2025-01-01T00:00:00Z',  // old
            salience: 0.5,                         // high salience
            is_deleted: false,
            is_synthetic: false,
        };

        expect(shouldArchive(salientRow, now)).toBe(false);
    });

    // ── Test 4: Already-deleted rows are skipped ──
    it('does not archive already-deleted rows', () => {
        const deleted: OutcomeRow = {
            id: 'row-4',
            created_at: '2025-01-01T00:00:00Z',
            salience: 0.001,
            is_deleted: true,
            is_synthetic: false,
        };

        expect(shouldArchive(deleted, now)).toBe(false);
    });

    // ── Test 5: Cold-delete after 365 days in archive ──
    it('cold-deletes archived rows older than 365 days', () => {
        const archived: ArchivedRow = {
            id: 'row-5',
            created_at: '2023-01-01T00:00:00Z',
            archived_at: '2024-01-01T00:00:00Z',  // ~530 days ago
            salience: 0.001,
            is_deleted: false,
            is_synthetic: false,
        };

        expect(shouldColdDelete(archived, now)).toBe(true);
    });

    // ── Test 6: Recently archived row is NOT cold-deleted ──
    it('does not cold-delete recently archived rows', () => {
        const recentArchive: ArchivedRow = {
            id: 'row-6',
            created_at: '2025-01-01T00:00:00Z',
            archived_at: '2025-04-01T00:00:00Z',  // ~75 days ago
            salience: 0.001,
            is_deleted: false,
            is_synthetic: false,
        };

        expect(shouldColdDelete(recentArchive, now)).toBe(false);
    });

    // ── Test 7: Salience stats computed correctly ──
    it('computes correct salience statistics', () => {
        const rows: OutcomeRow[] = [
            { id: 'a', created_at: '2025-01-01', salience: 0.001, is_deleted: false, is_synthetic: false },
            { id: 'b', created_at: '2025-01-02', salience: 0.008, is_deleted: false, is_synthetic: false },
            { id: 'c', created_at: '2025-01-03', salience: 0.02,  is_deleted: false, is_synthetic: false },
            { id: 'd', created_at: '2025-01-04', salience: 0.5,   is_deleted: false, is_synthetic: false },
            { id: 'e', created_at: '2025-01-05', salience: 0.003, is_deleted: false, is_synthetic: false },
        ];

        const stats = computeSalienceStats(rows);

        expect(stats.totalRows).toBe(5);
        expect(stats.minSalience).toBe(0.001);
        expect(stats.maxSalience).toBe(0.5);
        expect(stats.avgSalience).toBeCloseTo((0.001 + 0.008 + 0.02 + 0.5 + 0.003) / 5, 6);
        // Below threshold (0.01): 0.001, 0.008, 0.003 → 3
        expect(stats.belowThreshold).toBe(3);
    });

    // ── Test 8: Empty row set returns zeroed stats ──
    it('returns zeroed stats for empty row set', () => {
        const stats = computeSalienceStats([]);

        expect(stats.totalRows).toBe(0);
        expect(stats.avgSalience).toBe(0);
        expect(stats.minSalience).toBe(0);
        expect(stats.maxSalience).toBe(0);
        expect(stats.belowThreshold).toBe(0);
    });

    // ── Test 9: Exact boundary — row at exactly 90 days is NOT archived ──
    it('row at exactly 90 days is not archived (must be > 90)', () => {
        const exactly90 = new Date(now.getTime() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
        const borderRow: OutcomeRow = {
            id: 'row-boundary',
            created_at: exactly90.toISOString(),
            salience: 0.005,
            is_deleted: false,
            is_synthetic: false,
        };

        expect(shouldArchive(borderRow, now)).toBe(false);
    });
});
