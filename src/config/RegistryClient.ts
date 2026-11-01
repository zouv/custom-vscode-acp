// [CUSTOM-BEGIN] CUSTOM-20261101-008 - Validate the distribution-based ACP registry; timeout and coalesce fetches.
import { log, logError } from '../utils/Logger';

export interface RegistryAgent {
  id: string; name: string; description?: string; version?: string; website?: string;
  distribution?: Record<string, unknown>;
}

export function parseRegistry(data: unknown): RegistryAgent[] {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { agents?: unknown }).agents)) {
    throw new Error('Invalid ACP registry: expected agents array');
  }
  const seen = new Set<string>();
  return (data as { agents: unknown[] }).agents.flatMap(value => {
    if (!value || typeof value !== 'object') { return []; }
    const agent = value as Record<string, unknown>;
    if (typeof agent.id !== 'string' || typeof agent.name !== 'string' || seen.has(agent.id)) { return []; }
    seen.add(agent.id);
    return [{ id: agent.id, name: agent.name,
      ...(typeof agent.description === 'string' ? { description: agent.description } : {}),
      ...(typeof agent.website === 'string' ? { website: agent.website } : {}),
      ...(typeof agent.version === 'string' ? { version: agent.version } : {}),
      ...(agent.distribution && typeof agent.distribution === 'object' ? { distribution: agent.distribution as Record<string, unknown> } : {}),
    }];
  });
}

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
let cache: RegistryAgent[] | null = null;
let cacheTime = 0;
let inFlight: Promise<RegistryAgent[]> | null = null;
let generation = 0;

export async function fetchRegistry(): Promise<RegistryAgent[]> {
  if (cache && Date.now() - cacheTime < 5 * 60 * 1000) { return cache; }
  if (inFlight) { return inFlight; }
  const epoch = generation;
  const request = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      log('Fetching ACP agent registry...');
      const response = await fetch(REGISTRY_URL, { signal: abort.signal });
      if (!response.ok) { throw new Error('HTTP ' + response.status); }
      const agents = parseRegistry(await response.json());
      if (epoch === generation) { cache = agents; cacheTime = Date.now(); }
      return agents;
    } catch (error) { logError('Failed to fetch registry', error); return cache ?? []; }
    finally { clearTimeout(timer); if (epoch === generation) { inFlight = null; } }
  })();
  inFlight = request;
  return request;
}

export function clearRegistryCache(): void { cache = null; cacheTime = 0; inFlight = null; generation++; }
// [CUSTOM-END] CUSTOM-20261101-008
