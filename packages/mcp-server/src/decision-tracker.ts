/**
 * LayerInfinite MCP Server — decision-tracker.ts
 * ══════════════════════════════════════════════════════════════
 * Decision ID generation + episode tracking + buffer flush.
 * Replaces episode-tracker.ts (V1 redirect-loop prevention).
 *
 * Decision ID format: dec_{ts12}_{agent4}_{rand4}
 *   ts12    — base62-encoded timestamp (lexicographically sortable)
 *   agent4  — base62-encoded djb2 hash of agentId
 *   rand4   — 4 random base62 chars (collision prob < 10^-9 per ms)
 *
 * Buffer flushes every 5s to LI API. Disk queue fallback at
 * .li-queue/decisions.jsonl when API is unreachable.
 * ══════════════════════════════════════════════════════════════
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DecisionRecord, Episode } from './types.js';
import type { LiApiClient } from './rest-client.js';
import { logger } from './logger.js';

const log = logger.forTool('decision-tracker');

// ── Decision ID generation ──────────────────────────────────

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FLUSH_INTERVAL_MS = 5_000;
const EPISODE_TTL_MS = 30 * 60 * 1000;
const MAX_COACHING_PER_EPISODE = 3;
const DISK_QUEUE_DIR = '.li-queue';
const DISK_QUEUE_FILE = 'decisions.jsonl';
const MAX_BUFFER_SIZE = 10_000;

function base62Encode(n: number, minLen: number): string {
  let s = '';
  let v = n;
  while (v > 0) {
    s = BASE62[v % 62] + s;
    v = Math.floor(v / 62);
  }
  return s.padStart(minLen, '0');
}

function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash;
}

function randomBase62(len: number): string {
  let s = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) {
    s += BASE62[bytes[i] % 62];
  }
  return s;
}

export function generateDecisionId(agentId: string): string {
  const ts12 = base62Encode(Date.now(), 12);
  const agent4 = base62Encode(djb2(agentId), 4).slice(0, 4);
  const rand4 = randomBase62(4);
  return `dec_${ts12}_${agent4}_${rand4}`;
}

function generateEpisodeId(): string {
  const ts10 = base62Encode(Date.now(), 10);
  const rand6 = randomBase62(6);
  return `ep_${ts10}_${rand6}`;
}

// ══════════════════════════════════════════════════════════════
// DecisionTracker
// ══════════════════════════════════════════════════════════════

export class DecisionTracker {
  private readonly episodes = new Map<string, Episode>();
  private readonly buffer: DecisionRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private queueDirEnsured = false;

  constructor(
    private readonly liApi: LiApiClient,
    private readonly environment: 'staging' | 'production',
  ) {}

  // ── Episode management ───────────────────────────────────

  startEpisode(agentId: string, customerId: string): Episode {
    this.cleanExpiredEpisodes();

    const episode: Episode = {
      episodeId: generateEpisodeId(),
      agentId,
      sessionStart: new Date().toISOString(),
      decisions: [],
      coachingCount: 0,
    };

    this.episodes.set(episode.episodeId, episode);
    log.debug('Episode started', { episodeId: episode.episodeId, agentId, customerId });
    return episode;
  }

  getEpisode(episodeId: string): Episode | undefined {
    this.cleanExpiredEpisodes();
    return this.episodes.get(episodeId);
  }

  /** Record a coaching injection. Returns false if cap (3) already reached. */
  recordCoaching(episodeId: string): boolean {
    const episode = this.episodes.get(episodeId);
    if (!episode) return false;
    if (episode.coachingCount >= MAX_COACHING_PER_EPISODE) return false;
    episode.coachingCount++;
    return true;
  }

  canCoach(episodeId: string): boolean {
    const episode = this.episodes.get(episodeId);
    if (!episode) return true; // No episode yet — coaching is allowed
    return episode.coachingCount < MAX_COACHING_PER_EPISODE;
  }

  // ── Decision recording ───────────────────────────────────

  recordDecision(record: DecisionRecord): void {
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.buffer.shift();
      log.warn('Decision buffer full — dropping oldest entry');
    }
    this.buffer.push(record);

    // Link to episode
    if (this.episodes.size > 0) {
      // Find the most recent episode for this agent
      let latest: Episode | undefined;
      for (const ep of this.episodes.values()) {
        if (ep.agentId === record.agentId) {
          if (!latest || ep.sessionStart > latest.sessionStart) {
            latest = ep;
          }
        }
      }
      if (latest) {
        latest.decisions.push(record.decisionId);
      }
    }

    // Append to disk queue for durability
    this.appendToDiskQueue(record);

    log.debug('Decision recorded', { decisionId: record.decisionId });
  }

  // ── Flush ────────────────────────────────────────────────

  async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;

    this.flushing = true;
    const batch = this.buffer.splice(0);

    try {
      // Send each decision's outcome to LI API
      for (const record of batch) {
        const sent = await this.liApi.logOutcome({
          agent_id: record.agentId,
          customer_id: record.customerId,
          issue_type: record.taskType,
          action_name: record.actionName,
          upstream_name: record.upstreamName,
          original_action: record.originalAction,
          executed_action: record.executedAction,
          mode: record.mode,
          rerouted: record.rerouted,
          success: true,
          response_time_ms: 0,
          timestamp: record.timestamp,
          ingestion_source: 'mcp',
          environment: this.environment,
        });

        if (!sent) {
          // Re-queue on failure
          this.buffer.push(record);
        }
      }
    } catch (err) {
      log.warn('Buffer flush failed — re-queuing', {
        count: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      this.buffer.push(...batch);
    } finally {
      this.flushing = false;
    }
  }

  startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flushBuffer();
    }, FLUSH_INTERVAL_MS);
  }

  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Stats ────────────────────────────────────────────────

  get bufferSize(): number {
    return this.buffer.length;
  }

  get episodeCount(): number {
    this.cleanExpiredEpisodes();
    return this.episodes.size;
  }

  // ── Private ──────────────────────────────────────────────

  private appendToDiskQueue(record: DecisionRecord): void {
    try {
      if (!this.queueDirEnsured) {
        if (!existsSync(DISK_QUEUE_DIR)) {
          mkdirSync(DISK_QUEUE_DIR, { recursive: true });
        }
        this.queueDirEnsured = true;
      }
      appendFileSync(
        join(DISK_QUEUE_DIR, DISK_QUEUE_FILE),
        JSON.stringify(record) + '\n',
        'utf-8',
      );
    } catch {
      // Disk queue is best-effort — silent failure is acceptable
    }
  }

  private cleanExpiredEpisodes(): void {
    const cutoff = Date.now() - EPISODE_TTL_MS;
    for (const [id, ep] of this.episodes) {
      if (new Date(ep.sessionStart).getTime() < cutoff) {
        this.episodes.delete(id);
      }
    }
  }
}
