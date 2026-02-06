import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import puppeteer from '@/utils/puppeteer';

import login from './login';

export const route: Route = {
    path: '/activity',
    categories: ['other'],
    example: '/kickstarter/activity',
    parameters: {},
    features: {
        requireConfig: [
            {
                name: 'KICKSTARTER_USERNAME',
                description: 'Kickstarter email address for authentication',
            },
            {
                name: 'KICKSTARTER_PASSWORD',
                description: 'Kickstarter password for authentication',
            },
        ],
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'Backed Projects Activity',
    maintainers: [],
    handler,
    radar: [
        {
            source: ['kickstarter.com/activity'],
            target: '/activity',
        },
    ],
};

async function handler() {
    const username = config.kickstarter?.username;
    const password = config.kickstarter?.password;

    if (!username || !password) {
        throw new ConfigNotFoundError('Kickstarter username and password are required. Please set KICKSTARTER_USERNAME and KICKSTARTER_PASSWORD environment variables.');
    }

    // Get cached cookies or perform login
    const cookieString = await cache.tryGet(
        `kickstarter:cookies:${username}`,
        async () => {
            const cookies = await login({ username, password });
            if (!cookies) {
                throw new Error('Failed to login to Kickstarter');
            }
            return cookies;
        },
        7 * 24 * 60 * 60, // Cache for 7 days
        false
    );

    if (!cookieString) {
        throw new Error('Failed to obtain Kickstarter cookies');
    }

    // Deserialize cookies
    const cookieJar = CookieJar.deserializeSync(JSON.parse(cookieString));

    // Launch browser and navigate to activity page
    logger.debug('kickstarter debug: launching browser');
    const browser = await puppeteer();
    const page = await browser.newPage();

    // Set cookies before navigating
    logger.debug('kickstarter debug: setting cookies');
    const cookies = cookieJar.getCookiesSync('https://www.kickstarter.com');
    await Promise.all(
        cookies.map((cookie) =>
            page.setCookie({
                name: cookie.key,
                value: cookie.value,
                domain: cookie.domain || '.kickstarter.com',
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

    // Navigate to activity page
    // Use domcontentloaded instead of networkidle0 because Kickstarter has long-running connections
    logger.debug('kickstarter debug: navigating to activity page');
    await page.goto('https://www.kickstarter.com/activity', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });
    logger.debug('kickstarter debug: activity page loaded');

    // Wait for activity items to load
    logger.debug('kickstarter debug: waiting for activity items');
    await page.waitForSelector('.activity', { timeout: 30000 });
    logger.debug('kickstarter debug: activity items found');

    // Get page content
    const content = await page.content();
    await browser.close();

    // Parse with Cheerio
    const $ = load(content);

    const items: DataItem[] = [];

    $('.activity').each((_, el) => {
        const $activity = $(el);

        // Extract project info
        const $projectInfo = $activity.find('.project_info');

        // Get update link and title
        const updateLinkEl = $projectInfo.find('h3 a').first();
        const updateTitle = updateLinkEl.text().trim();
        const updateLink = updateLinkEl.attr('href');

        if (!updateLink || !updateTitle) {
            return; // Skip if we can't find basic info
        }

        // Get project name
        const projectNameEl = $projectInfo.find('h5 a').last();
        const projectName = projectNameEl.text().trim();

        // Get update number
        const updateNumberEl = $projectInfo.find('h5 a').first();
        const updateNumber = updateNumberEl.text().trim();

        // Get timestamp
        const timeEl = $projectInfo.find('time');
        const datetime = timeEl.attr('datetime');
        const pubDate = datetime ? parseDate(datetime) : new Date();

        // Get full content from the article
        const articleContent = $projectInfo.find('article.prose').html() || '';

        // If no article content, fall back to preview
        const previewContent = $projectInfo.find('.js-less').html() || '';

        const description = articleContent || previewContent;

        // Get metadata
        const likesText = $projectInfo.find('.post_likes .count').text().trim();
        const commentsText = $projectInfo.find('a[href*="#comments"]').text().trim();

        // Build full URL
        const fullUpdateLink = updateLink.startsWith('http') ? updateLink : `https://www.kickstarter.com${updateLink}`;

        const item: DataItem = {
            title: `${projectName} - ${updateNumber}: ${updateTitle}`,
            link: fullUpdateLink,
            description,
            pubDate,
            guid: fullUpdateLink,
            author: projectName,
        };

        // Add metadata to description
        if (likesText || commentsText) {
            let metadata = '<div style="margin-top: 1em; padding-top: 1em; border-top: 1px solid #eee; font-size: 0.9em; color: #666;">';
            if (likesText) {
                metadata += `<span style="margin-right: 1em;">${likesText}</span>`;
            }
            if (commentsText) {
                metadata += `<span>${commentsText}</span>`;
            }
            metadata += '</div>';
            item.description += metadata;
        }

        items.push(item);
    });

    return {
        title: 'Kickstarter - Backed Projects Activity',
        link: 'https://www.kickstarter.com/activity',
        description: 'Activity feed for your backed Kickstarter projects',
        item: items,
    };
}
