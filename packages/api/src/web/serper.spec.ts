import { z } from 'zod';
import axios from 'axios';
import { Agent } from 'node:https';
import { tool } from '@langchain/core/tools';
import { SearchProviders, ScraperProviders, RerankerTypes } from 'librechat-data-provider';
import { createWebSearchTool } from './serper';

jest.mock('axios');

describe('Serper gateway search', () => {
  const post = jest.mocked(axios.post);
  const options = {
    searchProvider: SearchProviders.SERPER,
    scraperProvider: ScraperProviders.KEENABLE,
    rerankerType: RerankerTypes.NONE,
    serperSearchUrl: 'https://gateway.example/serper/search',
    serperApiKey: 'gateway-secret',
  };
  const dependencies = {
    createSearchTool: () => {
      throw new Error('Unexpected default routing');
    },
    httpClient: axios,
  };
  const invoke = (config = options) =>
    createWebSearchTool(config, dependencies).invoke({
      type: 'tool_call',
      id: 'search-test',
      name: 'web_search',
      args: { query: 'example query', country: 'DK', date: 'w' },
    });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends the key only to the configured endpoint and preserves citations', async () => {
    post.mockResolvedValue({
      data: {
        organic: [{ title: 'Example', link: 'https://example.com', snippet: 'Summary' }],
      },
    });

    const result = await invoke();

    expect(post).toHaveBeenCalledWith(
      options.serperSearchUrl,
      expect.objectContaining({ q: 'example query', gl: 'dk', tbs: 'qdr:w' }),
      expect.objectContaining({
        maxRedirects: 0,
        headers: { 'X-API-KEY': options.serperApiKey, 'Content-Type': 'application/json' },
      }),
    );
    expect(result.content).toContain('\\ue202turn0search0');
    expect(result.artifact.web_search.organic).toEqual([
      { title: 'Example', link: 'https://example.com', snippet: 'Summary' },
    ]);
  });

  it('uses only Bearer authentication when configured for a gateway', async () => {
    post.mockResolvedValue({ data: { organic: [] } });

    await createWebSearchTool(
      { ...options, serperAuthHeader: 'Authorization' },
      dependencies,
    ).invoke({ query: 'example' });

    expect(post).toHaveBeenCalledWith(
      options.serperSearchUrl,
      expect.any(Object),
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${options.serperApiKey}`,
          'Content-Type': 'application/json',
        },
      }),
    );
  });

  it('returns a successful empty result separately from a provider failure', async () => {
    post.mockResolvedValue({ data: { organic: [] } });

    const result = await invoke();

    expect(result.content).toBe('No search results found.');
    expect(result.artifact.web_search).not.toHaveProperty('error');
  });

  it('does not disclose upstream errors or retry against the public provider', async () => {
    post.mockRejectedValue(new Error('gateway-secret sensitive provider payload'));

    const result = await invoke();

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Search is temporarily unavailable.');
    expect(JSON.stringify(result)).not.toContain('gateway-secret');
    expect(JSON.stringify(result)).not.toContain('sensitive provider payload');
  });

  it.each([{ organic: 'sensitive invalid payload' }, { error: 'private gateway error' }, {}])(
    'rejects invalid provider data safely: %p',
    async (data) => {
      post.mockResolvedValue({ data });

      const result = await invoke();

      expect(result.artifact.web_search.error).toBe('Search is temporarily unavailable.');
    },
  );

  it('forwards cancellation and SSRF agents and publishes citation results', async () => {
    const controller = new AbortController();
    const httpsAgent = new Agent();
    const onSearchResults = jest.fn();
    post.mockResolvedValue({
      data: { organic: [{ title: 'Example', link: 'https://example.com' }] },
    });

    const search = createWebSearchTool({ ...options, httpsAgent, onSearchResults }, dependencies);
    await search.invoke({ query: 'example' }, { signal: controller.signal });

    expect(post).toHaveBeenCalledWith(
      options.serperSearchUrl,
      expect.any(Object),
      expect.objectContaining({ httpsAgent, signal: controller.signal }),
    );
    expect(onSearchResults).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: 0,
        organic: [{ title: 'Example', link: 'https://example.com' }],
      }),
      expect.any(Object),
    );
  });

  it('refuses to send gateway credentials to the public Serper scraper', () => {
    expect(() =>
      createWebSearchTool({ ...options, scraperProvider: ScraperProviders.SERPER }, dependencies),
    ).toThrow('SERPER_GATEWAY_SCRAPER_UNSUPPORTED');
  });

  it.each([
    'file:///etc/passwd',
    'https://user:secret@example.com/search',
    'https://example.com/search?key=secret',
    'https://example.com/search#fragment',
  ])('rejects unsafe gateway URL %s', (serperSearchUrl) => {
    expect(() => createWebSearchTool({ ...options, serperSearchUrl }, dependencies)).toThrow(
      'SERPER_SEARCH_URL_INVALID',
    );
  });

  it('preserves the built-in factory when no custom URL is configured', () => {
    const factory = jest.fn(() =>
      tool(async () => 'Default tool', {
        name: 'web_search',
        description: 'Default search',
        schema: z.object({ query: z.string() }),
      }),
    );

    createWebSearchTool(
      { ...options, serperSearchUrl: undefined },
      { ...dependencies, createSearchTool: factory },
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
