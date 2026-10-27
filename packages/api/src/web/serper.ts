import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { TWebSearchConfig } from 'librechat-data-provider';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AxiosInstance } from 'axios';
import type https from 'node:https';
import type http from 'node:http';

interface SearchSource {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  source?: string;
}

type SearchOptions = Partial<TWebSearchConfig> & {
  serperSearchUrl?: string;
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent;
  onSearchResults?: (
    result: {
      turn: number;
      organic: SearchSource[];
      topStories: SearchSource[];
    },
    config: RunnableConfig,
  ) => void;
};

interface SearchDependencies {
  createSearchTool: (config: SearchOptions) => StructuredToolInterface;
  httpClient: Pick<AxiosInstance, 'post'>;
}

const sourceSchema = z.object({
  title: z.string().default(''),
  link: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value)),
  snippet: z.string().optional(),
  date: z.string().optional(),
  source: z.string().optional(),
});

const responseSchema = z
  .object({
    organic: z.array(sourceSchema).optional(),
    news: z.array(sourceSchema).optional(),
    topStories: z.array(sourceSchema).optional(),
  })
  .refine((value) => value.organic != null || value.news != null || value.topStories != null);

const inputSchema = z.object({
  query: z.string().trim().min(1),
  country: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .optional(),
  date: z.enum(['h', 'd', 'w', 'm', 'y']).optional(),
  intent: z.string().optional(),
});

export function createWebSearchTool(
  config: SearchOptions,
  dependencies: SearchDependencies,
): StructuredToolInterface {
  if (config.serperSearchUrl && config.scraperProvider === 'serper') {
    throw new Error('SERPER_GATEWAY_SCRAPER_UNSUPPORTED');
  }
  if ((config.searchProvider ?? 'serper') !== 'serper' || !config.serperSearchUrl) {
    return dependencies.createSearchTool(config);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.serperSearchUrl);
  } catch {
    throw new Error('SERPER_SEARCH_URL_INVALID');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('SERPER_SEARCH_URL_INVALID');
  }
  if (!config.serperApiKey) {
    throw new Error('SERPER_API_KEY_REQUIRED');
  }

  return tool(
    async ({ query, country, date }, runnableConfig) => {
      const { turn } = z
        .object({ turn: z.number().default(0) })
        .parse(runnableConfig.toolCall ?? {});
      try {
        const response = await dependencies.httpClient.post(
          endpoint.toString(),
          {
            q: query,
            num: 8,
            safe: ['off', 'moderate', 'active'][config.safeSearch ?? 1],
            ...(country && { gl: country.toLowerCase() }),
            ...(date && { tbs: `qdr:${date}` }),
          },
          {
            headers: {
              [config.serperAuthHeader ?? 'X-API-KEY']:
                config.serperAuthHeader === 'Authorization'
                  ? `Bearer ${config.serperApiKey}`
                  : config.serperApiKey,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
            maxRedirects: 0,
            signal: runnableConfig.signal,
            httpAgent: config.httpAgent,
            httpsAgent: config.httpsAgent,
          },
        );
        const result = responseSchema.parse(response.data);
        const data = {
          turn,
          organic: result.organic ?? [],
          topStories: [...(result.topStories ?? []), ...(result.news ?? [])],
          images: [],
          videos: [],
          relatedSearches: [],
          references: [],
        };
        config.onSearchResults?.(data, runnableConfig);
        const sections = [
          ...data.organic.map((source, index) => ({ source, index, kind: 'search' })),
          ...data.topStories.map((source, index) => ({ source, index, kind: 'news' })),
        ];
        const content = sections
          .map(
            ({ source, index, kind }) =>
              `${source.title}\nAnchor: \\ue202turn${turn}${kind}${index}\nURL: ${source.link}\n${source.snippet ?? ''}`,
          )
          .join('\n\n');
        return [content || 'No search results found.', { web_search: data }];
      } catch {
        const data = { turn, error: 'Search is temporarily unavailable.', references: [] };
        return [data.error, { web_search: data }];
      }
    },
    {
      name: 'web_search',
      description:
        'Search the web for current information. Returns links and snippets for citation, not full page contents.',
      schema: inputSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}
