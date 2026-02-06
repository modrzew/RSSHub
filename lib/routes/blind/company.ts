import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import puppeteer from '@/utils/puppeteer';

import login from './login';

// Timeout constants
const COMPANY_PAGE_TIMEOUT = 60000;
const POST_SELECTOR_TIMEOUT = 30000;

export const route: Route = {
    path: '/company',
    categories: ['other'],
    example: '/blind/company',
    parameters: {},
    features: {
        requireConfig: [
            {
                name: 'BLIND_USERNAME',
                description: 'Blind email address for authentication',
            },
            {
                name: 'BLIND_PASSWORD',
                description: 'Blind password for authentication',
            },
            {
                name: 'BLIND_COMPANY_URL',
                description: 'Blind company page URL (e.g., https://www.teamblind.com/private/meta)',
            },
        ],
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'Company Posts',
    maintainers: [],
    handler,
    radar: [
        {
            source: ['teamblind.com/private/:company'],
            target: '/company',
        },
    ],
};

async function handler() {
    const username = config.blind?.username;
    const password = config.blind?.password;
    const companyUrl = config.blind?.companyUrl;

    if (!username || !password) {
        throw new ConfigNotFoundError('Blind username and password are required. Please set BLIND_USERNAME and BLIND_PASSWORD environment variables.');
    }

    if (!companyUrl) {
        throw new ConfigNotFoundError('Blind company URL is required. Please set BLIND_COMPANY_URL environment variable (e.g., https://www.teamblind.com/private/meta).');
    }

    // Validate URL format
    if (!companyUrl.startsWith('https://www.teamblind.com/')) {
        throw new Error('Invalid company URL. Must start with https://www.teamblind.com/');
    }

    // Get cached cookies or perform login
    const cookieString = await cache.tryGet(
        `blind:cookies:${username}`,
        async () => {
            const cookies = await login({ username, password });
            if (!cookies) {
                throw new Error('Failed to login to Blind');
            }
            return cookies;
        },
        7 * 24 * 60 * 60, // Cache for 7 days
        false
    );

    if (!cookieString) {
        throw new Error('Failed to obtain Blind cookies');
    }

    // Deserialize cookies
    const cookieJar = CookieJar.deserializeSync(JSON.parse(cookieString));

    // Launch browser and navigate to company page
    logger.debug('blind debug: launching browser');
    const browser = await puppeteer();
    let content: string;
    try {
        const page = await browser.newPage();

        // Set cookies before navigating
        logger.debug('blind debug: setting cookies');
        const cookies = cookieJar.getCookiesSync('https://www.teamblind.com');
        await Promise.all(
            cookies.map((cookie) =>
                page.setCookie({
                    name: cookie.key,
                    value: cookie.value,
                    domain: cookie.domain || '.teamblind.com',
                    path: cookie.path || '/',
                    expires: cookie.expires === 'Infinity' ? -1 : Math.floor(new Date(cookie.expires).getTime() / 1000),
                    httpOnly: cookie.httpOnly || false,
                    secure: cookie.secure || false,
                    sameSite: (cookie.sameSite as 'Strict' | 'Lax' | 'None') || 'Lax',
                })
            )
        );

        // Set up request interception to skip loading images, stylesheets, and fonts
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate to company page
        logger.debug('blind debug: navigating to company page');
        await page.goto(companyUrl, {
            waitUntil: 'domcontentloaded',
            timeout: COMPANY_PAGE_TIMEOUT,
        });
        logger.debug('blind debug: company page loaded');

        // Wait for post items to load
        logger.debug('blind debug: waiting for post items');
        await page.waitForSelector('article[data-article-alias]', { timeout: POST_SELECTOR_TIMEOUT });
        logger.debug('blind debug: post items found');

        // Get page content
        content = await page.content();
    } finally {
        await browser.close();
    }

    // Parse with Cheerio
    const $ = load(content);

    const items: DataItem[] = [];

    // Extract company name from URL or page title
    const companyName = companyUrl.split('/private/')[1]?.split('/')[0] || 'Company';
    const pageTitle = $('title').text() || `Blind - ${companyName}`;

    $('article[data-article-alias]').each((_, el) => {
        const $article = $(el);

        // Extract post ID
        const postId = $article.attr('data-article-alias');

        // Get post title
        const titleEl = $article.find('[data-testid="article-preview-title"]');
        const title = titleEl.text().trim();

        if (!title || !postId) {
            return; // Skip if we can't find basic info
        }

        // Get post URL
        const postUrl = `https://www.teamblind.com/post/${postId}`;

        // Get author/channel
        const authorEl = $article.find('[data-testid="article-preview-channel"]');
        const author = authorEl.text().trim() || companyName;

        // Get timestamp (relative time like "Yesterday", "3d", "2h")
        // The timestamp is a sibling of the channel link in the article header
        const headerDiv = authorEl.closest('div');
        const timeText = headerDiv.find('span.text-gray-600').first().text().trim();

        // Try to parse relative time to absolute date
        // Formats: "Yesterday", "3d", "2h", "45m", "Jan 29"
        let pubDate = new Date();
        if (timeText === 'Yesterday') {
            pubDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        } else if (timeText === 'Today') {
            pubDate = new Date();
        } else if (timeText.endsWith('d')) {
            // Days: "3d" -> 3 days ago
            const days = Number.parseInt(timeText.slice(0, -1)) || 1;
            pubDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        } else if (timeText.endsWith('h')) {
            // Hours: "2h" -> 2 hours ago
            const hours = Number.parseInt(timeText.slice(0, -1)) || 1;
            pubDate = new Date(Date.now() - hours * 60 * 60 * 1000);
        } else if (timeText.endsWith('m')) {
            // Minutes: "45m" -> 45 minutes ago
            const minutes = Number.parseInt(timeText.slice(0, -1)) || 1;
            pubDate = new Date(Date.now() - minutes * 60 * 1000);
        } else if (/^[A-Z][a-z]{2}\s+\d{1,2}$/.test(timeText)) {
            // Absolute date: "Jan 29", "Feb 15" (month + day, no year)
            const now = new Date();
            const currentYear = now.getFullYear();

            // Parse with current year first (using UTC to avoid timezone issues)
            const parsedDate = new Date(`${timeText}, ${currentYear} 12:00:00 UTC`);

            // If the date is in the future, it must be from last year
            pubDate = parsedDate > now ? new Date(`${timeText}, ${currentYear - 1} 12:00:00 UTC`) : parsedDate;
        }

        logger.debug(`blind debug: Post "${title.slice(0, 40)}..." - timeText: "${timeText}" -> pubDate: ${pubDate.toISOString()}`);

        // Get preview content - it's in a <p> tag after the title
        const titleParent = titleEl.parent();
        const previewEl = titleParent.find('p').first();
        const description = previewEl.html() || title;

        // Get metadata (comments, shares, views)
        const metadataCounts: string[] = [];
        $article.find('[data-count]').each((__, metaEl) => {
            const count = $(metaEl).attr('data-count');
            const text = $(metaEl).text().trim();
            if (count && text) {
                metadataCounts.push(text);
            }
        });

        const item: DataItem = {
            title,
            link: postUrl,
            description,
            pubDate,
            guid: postUrl,
            author,
        };

        // Add metadata to description
        if (metadataCounts.length > 0) {
            let metadata = '<div style="margin-top: 1em; padding-top: 1em; border-top: 1px solid #eee; font-size: 0.9em; color: #666;">';
            metadata += metadataCounts.join(' • ');
            metadata += '</div>';
            item.description += metadata;
        }

        items.push(item);
    });

    // Sort items by date, newest first
    items.sort((a, b) => {
        const dateA = a.pubDate instanceof Date ? a.pubDate.getTime() : 0;
        const dateB = b.pubDate instanceof Date ? b.pubDate.getTime() : 0;
        return dateB - dateA;
    });

    return {
        title: pageTitle,
        link: companyUrl,
        description: `Posts from ${companyName} on Blind`,
        item: items,
    };
}
