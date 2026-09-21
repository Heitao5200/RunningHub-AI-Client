import { ApiKeyConfig } from '../types';
import { getAccountInfo, getApiQueueStatus } from './api';

const PROBE_TTL_MS = 2500;

export interface ApiCapacitySnapshot {
  apiKey: string;
  configuredSlots: number;
  localInFlight: number;
  externalInFlight: number;
  remoteInFlight: number;
  availableSlots: number;
  currentTaskCountsRaw: string | null;
}

export const parseCurrentTaskCounts = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const raw = String(value ?? '').trim();
  if (!raw) {
    return 0;
  }

  const match = raw.match(/\d+/);
  return match ? Math.max(0, parseInt(match[0], 10) || 0) : 0;
};

export class ApiCapacityManager {
  readonly apiKey: string;
  configuredSlots: number;
  readonly index: number;

  private localInFlight = 0;
  private externalInFlight = 0;
  private remoteInFlight = 0;
  private currentTaskCountsRaw: string | null = null;
  private lastProbeAt = 0;
  private probePromise: Promise<ApiCapacitySnapshot> | null = null;
  private retryAfter = 0;

  constructor(config: ApiKeyConfig, index: number) {
    this.apiKey = config.apiKey.trim();
    this.configuredSlots = normalizeConcurrency(config.concurrency);
    this.index = index;
  }

  getSnapshot(): ApiCapacitySnapshot {
    return {
      apiKey: this.apiKey,
      configuredSlots: this.configuredSlots,
      localInFlight: this.localInFlight,
      externalInFlight: this.externalInFlight,
      remoteInFlight: this.remoteInFlight,
      availableSlots: Date.now() < this.retryAfter ? 0 : Math.max(0, this.configuredSlots - this.localInFlight - this.externalInFlight),
      currentTaskCountsRaw: this.currentTaskCountsRaw,
    };
  }

  async probe(force = false): Promise<ApiCapacitySnapshot> {
    const now = Date.now();
    if (!force && !this.probePromise && now - this.lastProbeAt < PROBE_TTL_MS) {
      return this.getSnapshot();
    }

    if (this.probePromise) {
      return this.probePromise;
    }

    this.probePromise = (async () => {
      try {
        let taskCounts: unknown;
        try {
          const queue = await getApiQueueStatus(this.apiKey);
          this.configuredSlots = normalizeConcurrency(queue.concurrentLimit);
          taskCounts = queue.totalCurrentTasks;
        } catch (error: any) {
          // The queue endpoint is still labelled "in development" in the docs.
          // Fall back only when unavailable; authentication errors must stay visible.
          if (!/HTTP Error: (404|405|5\d\d)/.test(String(error?.message))) throw error;
          taskCounts = (await getAccountInfo(this.apiKey)).currentTaskCounts;
        }
        const remoteInFlight = parseCurrentTaskCounts(taskCounts);

        this.remoteInFlight = remoteInFlight;
        this.currentTaskCountsRaw = taskCounts == null ? null : String(taskCounts);
        this.externalInFlight = Math.max(0, remoteInFlight - this.localInFlight);
        this.lastProbeAt = Date.now();

        return this.getSnapshot();
      } finally {
        this.probePromise = null;
      }
    })();

    return this.probePromise;
  }

  reserveSlot(): boolean {
    if (this.getSnapshot().availableSlots <= 0) {
      return false;
    }

    this.localInFlight += 1;
    return true;
  }

  releaseSlot(): void {
    this.localInFlight = Math.max(0, this.localInFlight - 1);
    this.markProbeStale();
  }

  markCapacityLimited(): void {
    this.retryAfter = Date.now() + 3000;
    this.markProbeStale();
  }

  markProbeStale(): void {
    this.lastProbeAt = 0;
  }
}

const normalizeConcurrency = (value: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

export const normalizeApiConfigs = (apiConfigs: ApiKeyConfig[]): ApiKeyConfig[] => {
  const configs = new Map<string, ApiKeyConfig>();
  apiConfigs.forEach(config => {
    const apiKey = config.apiKey.trim();
    if (apiKey && !configs.has(apiKey)) {
      configs.set(apiKey, { apiKey, concurrency: normalizeConcurrency(config.concurrency) });
    }
  });
  return [...configs.values()];
};

export const createApiCapacityManagers = (apiConfigs: ApiKeyConfig[]): ApiCapacityManager[] =>
  normalizeApiConfigs(apiConfigs).map((config, index) => new ApiCapacityManager(config, index));
