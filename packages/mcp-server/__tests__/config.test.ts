import { describe, it, expect, beforeEach, vi } from 'vitest';

let loadConfig: () => ReturnType<typeof import('../src/config.js').loadConfig>;

beforeEach(() => {
  delete process.env.LAYERINFINITE_API_KEY;
  delete process.env.LAYERINFINITE_MODE;
  delete process.env.LAYERINFINITE_BASE_URL;
  delete process.env.LAYERINFINITE_UPSTREAM_TOOLS;
  delete process.env.LAYERINFINITE_MODE_OVERRIDES;
  delete process.env.LAYERINFINITE_SHADOW_MODE;
  delete process.env.LAYERINFINITE_ENVIRONMENT;
  delete process.env.LAYERINFINITE_ADMIN_KEY;
  delete process.env.LAYERINFINITE_LOG_LEVEL;
  delete process.env.LI_CLASSIFIER_ENABLED;
  delete process.env.LI_CLASSIFIER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NODE_ENV;
  vi.resetModules();
});

async function importConfig() {
  const mod = await import('../src/config.js');
  loadConfig = mod.loadConfig;
}

describe('loadConfig', () => {
  it('throws when LAYERINFINITE_API_KEY is missing', async () => {
    await importConfig();
    expect(() => loadConfig()).toThrow('LAYERINFINITE_API_KEY is required');
  });

  it('throws when LAYERINFINITE_API_KEY is empty', async () => {
    process.env.LAYERINFINITE_API_KEY = '   ';
    await importConfig();
    expect(() => loadConfig()).toThrow('LAYERINFINITE_API_KEY is required');
  });

  it('loads minimal config with only API key', async () => {
    process.env.LAYERINFINITE_API_KEY = 'test-key-123';
    await importConfig();
    const config = loadConfig();
    expect(config.apiKey).toBe('test-key-123');
    expect(config.baseUrl).toBe('https://layerinfinite.me');
    expect(config.mode).toBeNull();
    expect(config.upstreamServers).toEqual([]);
    expect(config.shadowMode).toBe(false);
    expect(config.environment).toBe('production');
  });

  it('strips trailing slash from base URL', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_BASE_URL = 'https://custom.example.com/';
    await importConfig();
    expect(loadConfig().baseUrl).toBe('https://custom.example.com');
  });

  it('accepts valid modes', async () => {
    await importConfig();
    for (const mode of ['recommend', 'assist', 'auto']) {
      vi.resetModules();
      delete process.env.LAYERINFINITE_MODE;
      process.env.LAYERINFINITE_API_KEY = 'k';
      process.env.LAYERINFINITE_MODE = mode;
      const mod = await import('../src/config.js');
      expect(mod.loadConfig().mode).toBe(mode);
    }
  });

  it('throws on invalid mode', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_MODE = 'invalid_mode';
    await importConfig();
    expect(() => loadConfig()).toThrow('Invalid LAYERINFINITE_MODE');
  });

  it('parses valid upstream servers JSON', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_UPSTREAM_TOOLS = JSON.stringify([
      { name: 'github', url: 'https://gh.example.com', apiKey: 'gh-key' },
      { name: 'database', url: 'http://localhost:8080' },
    ]);
    await importConfig();
    const config = loadConfig();
    expect(config.upstreamServers).toHaveLength(2);
    expect(config.upstreamServers[0].name).toBe('github');
    expect(config.upstreamServers[0].apiKey).toBe('gh-key');
    expect(config.upstreamServers[1].name).toBe('database');
  });

  it('throws on invalid upstream JSON', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_UPSTREAM_TOOLS = 'not-json';
    await importConfig();
    expect(() => loadConfig()).toThrow('not valid JSON');
  });

  it('throws when upstream is missing name', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_UPSTREAM_TOOLS = JSON.stringify([{ url: 'https://x.com' }]);
    await importConfig();
    expect(() => loadConfig()).toThrow('"name" is required');
  });

  it('throws when upstream is missing url', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_UPSTREAM_TOOLS = JSON.stringify([{ name: 'x' }]);
    await importConfig();
    expect(() => loadConfig()).toThrow('"url" is required');
  });

  it('parses mode overrides', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_MODE_OVERRIDES = JSON.stringify({
      build_failed: 'auto',
      ci_timeout: 'assist',
    });
    await importConfig();
    const config = loadConfig();
    expect(config.modeOverrides.get('build_failed')).toBe('auto');
    expect(config.modeOverrides.get('ci_timeout')).toBe('assist');
  });

  it('throws on invalid mode override value', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_MODE_OVERRIDES = JSON.stringify({ bad: 'invalid' });
    await importConfig();
    expect(() => loadConfig()).toThrow('LAYERINFINITE_MODE_OVERRIDES');
  });

  it('handles empty mode overrides', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_MODE_OVERRIDES = '{}';
    await importConfig();
    expect(loadConfig().modeOverrides.size).toBe(0);
  });

  it('enables shadow mode', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_SHADOW_MODE = 'true';
    await importConfig();
    expect(loadConfig().shadowMode).toBe(true);
  });

  it('throws on invalid environment', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_ENVIRONMENT = 'dev';
    await importConfig();
    expect(() => loadConfig()).toThrow('Invalid LAYERINFINITE_ENVIRONMENT');
  });

  it('accepts staging environment', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_ENVIRONMENT = 'staging';
    await importConfig();
    expect(loadConfig().environment).toBe('staging');
  });

  it('reads admin key', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_ADMIN_KEY = 'admin-secret';
    await importConfig();
    expect(loadConfig().adminKey).toBe('admin-secret');
  });

  it('admin key is null when unset', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    await importConfig();
    expect(loadConfig().adminKey).toBeNull();
  });

  it('derives log level from NODE_ENV production', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.NODE_ENV = 'production';
    await importConfig();
    expect(loadConfig().logLevel).toBe('info');
  });

  it('respects explicit log level over NODE_ENV', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LAYERINFINITE_LOG_LEVEL = 'warn';
    process.env.NODE_ENV = 'production';
    await importConfig();
    expect(loadConfig().logLevel).toBe('warn');
  });

  it('enables classifier when LI_CLASSIFIER_ENABLED=true', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    process.env.LI_CLASSIFIER_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'sk-openai-key';
    await importConfig();
    const config = loadConfig();
    expect(config.classifier).not.toBeNull();
    expect(config.classifier!.enabled).toBe(true);
    expect(config.classifier!.model).toBe('gpt-4o-mini');
  });

  it('classifier is null when not enabled', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    await importConfig();
    expect(loadConfig().classifier).toBeNull();
  });

  it('config is frozen (immutable)', async () => {
    process.env.LAYERINFINITE_API_KEY = 'k';
    await importConfig();
    const config = loadConfig();
    expect(() => {
      (config as { mode: string }).mode = 'auto';
    }).toThrow();
  });
});
