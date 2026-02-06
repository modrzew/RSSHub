import { RateLimiterMemory, RateLimiterQueue, RateLimiterRedis } from 'rate-limiter-flexible';
import { CookieJar } from 'tough-cookie';

import cache from '@/utils/cache';
import logger from '@/utils/logger';
import puppeteer from '@/utils/puppeteer';

// Timeout constants
const LOGIN_PAGE_TIMEOUT = 30000;
const FIELD_WAIT_TIMEOUT = 10000;
const NAVIGATION_TIMEOUT = 20000;
const PAGE_SETTLE_DELAY = 2000;

const loginLimiter = cache.clients.redisClient
    ? new RateLimiterRedis({
          points: 1,
          duration: 20,
          execEvenly: true,
          storeClient: cache.clients.redisClient,
      })
    : new RateLimiterMemory({
          points: 1,
          duration: 20,
          execEvenly: true,
      });

const loginLimiterQueue = new RateLimiterQueue(loginLimiter);

async function login({ username, password }: { username: string; password: string }) {
    if (!username || !password) {
        return;
    }
    try {
        await loginLimiterQueue.removeTokens(1);

        const cookieJar = new CookieJar();
        const browser = await puppeteer();
        try {
            const page = await browser.newPage();

            logger.debug('blind debug: navigating to login page');
            await page.goto('https://www.teamblind.com/sign-in', {
                waitUntil: 'domcontentloaded',
                timeout: LOGIN_PAGE_TIMEOUT,
            });
            logger.debug('blind debug: login page loaded');

            // Wait for email field to appear
            await page.waitForSelector('#email', { timeout: FIELD_WAIT_TIMEOUT });

            // Fill in credentials
            logger.debug('blind debug: filling credentials');
            await page.type('#email', username);
            await page.type('#password', password);

            // Click submit button
            logger.debug('blind debug: submitting login form');
            await page.click('button[type="submit"]');

            // Wait for navigation to complete
            try {
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
            } catch {
                // Navigation might not trigger if there's an error, continue anyway
            }

            // Give page a moment to settle after navigation
            await new Promise((resolve) => setTimeout(resolve, PAGE_SETTLE_DELAY));

            // Check if login was successful by looking for URL change
            const currentUrl = page.url();

            if (currentUrl.includes('/sign-in')) {
                // Still on login page, login probably failed
                logger.error('blind debug: login failed: still on login page');
                return '';
            }

            // Extract cookies
            const cookies = await page.cookies();
            for (const cookie of cookies) {
                cookieJar.setCookieSync(`${cookie.name}=${cookie.value}`, 'https://www.teamblind.com');
            }

            logger.debug('blind debug: login success');

            return JSON.stringify(cookieJar.serializeSync());
        } finally {
            await browser.close();
        }
    } catch (error) {
        logger.error('blind debug: login failed:', error);
        return '';
    }
}

export default login;
