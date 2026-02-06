import { RateLimiterMemory, RateLimiterQueue, RateLimiterRedis } from 'rate-limiter-flexible';
import { CookieJar } from 'tough-cookie';

import cache from '@/utils/cache';
import logger from '@/utils/logger';
import puppeteer from '@/utils/puppeteer';

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
        const page = await browser.newPage();

        logger.debug('kickstarter debug: navigating to login page');
        await page.goto('https://www.kickstarter.com/login', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        logger.debug('kickstarter debug: login page loaded');

        // Wait for email field to appear
        await page.waitForSelector('#user_session_email', { timeout: 10000 });

        // Fill in credentials
        logger.debug('kickstarter debug: filling credentials');
        await page.type('#user_session_email', username);
        await page.type('#user_session_password', password);

        // Click submit button
        logger.debug('kickstarter debug: submitting login form');
        await page.click('input[type="submit"][value="Log in"]');

        // Wait for navigation to complete - either we're redirected or an error appears
        // Use domcontentloaded as networkidle0 may never happen due to analytics/tracking
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch {
            // Navigation might not trigger if there's an error, continue anyway
        }

        // Give page a moment to settle after navigation
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check if login was successful by looking for elements that only appear when logged in
        // If we're on a logged-in page, the URL should change from /login
        const currentUrl = page.url();

        if (currentUrl.includes('/login')) {
            // Still on login page, login probably failed
            logger.error('kickstarter debug: login failed: still on login page');
            await browser.close();
            return '';
        }

        // Extract cookies
        const cookies = await page.cookies();
        for (const cookie of cookies) {
            cookieJar.setCookieSync(`${cookie.name}=${cookie.value}`, 'https://www.kickstarter.com');
        }

        logger.debug('kickstarter debug: login success');

        await browser.close();
        return JSON.stringify(cookieJar.serializeSync());
    } catch (error) {
        logger.error('kickstarter debug: login failed:', error);
        return '';
    }
}

export default login;
