import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { GthConfig } from '@gaunt-sloth/core/config.js';

const toolDefinition = {
  name: 'gth_web_fetch',
  description:
    'Fetch content from a web URL. Provide a valid HTTP/HTTPS URL and get the content as text.',
  schema: z.string().describe('URL to make HTTP request'),
};

const defaultHttpHeaders = {
  Accept: 'text/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

/**
 * Fetches content from a given URL and returns it as a string
 * @param url - The URL to fetch content from
 * @returns Promise<string> - The fetched content as a string
 */
async function gthWebFetchImpl(url: string): Promise<string> {
  try {
    if (!url || typeof url !== 'string' || !url.trim()) {
      return Promise.reject('Invalid URL provided');
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return Promise.reject('URL must start with http:// or https://');
    }

    const response = await fetch(url, {
      headers: {
        ...defaultHttpHeaders,
      },
    });

    if (!response.ok) {
      return Promise.reject(
        `Failed to fetch data from ${url} with status: ${response.status} - ${response.statusText}`
      );
    }

    return response.text();
  } catch (error) {
    // graceful error handling and returning
    return Promise.reject(`Unknown error occurred while fetching content from ${url}: ${error}`);
  }
}

const toolImpl = async (url: string) => {
  return await gthWebFetchImpl(url);
};

export function get(_: GthConfig) {
  return tool(toolImpl, toolDefinition);
}
