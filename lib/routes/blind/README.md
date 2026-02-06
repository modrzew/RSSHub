# Blind Routes

## Company Posts

Get posts from a specific company page on Blind.

### Route

`/blind/company`

### Example

`http://localhost:1200/blind/company`

### Configuration

This route requires authentication with your Blind account and a company page URL. Set the following environment variables:

```bash
export BLIND_USERNAME="your_email@example.com"
export BLIND_PASSWORD="your_password"
export BLIND_COMPANY_URL="https://www.teamblind.com/private/meta"
```

Replace `meta` with your desired company name. Common examples:

- Meta: `https://www.teamblind.com/private/meta`
- Google: `https://www.teamblind.com/private/google`
- Amazon: `https://www.teamblind.com/private/amazon`
- Microsoft: `https://www.teamblind.com/private/microsoft`

### How it works

1. The route uses Puppeteer to log into Blind with your credentials
2. Cookies are cached for 7 days to minimize login requests
3. The company page is scraped to extract posts
4. Each post includes:
    - Post title
    - Preview content
    - Timestamp (relative time converted to approximate date)
    - Author/channel name
    - Link to full post
    - Engagement metrics (comments, shares, views)

### Notes

- Requires Puppeteer to be installed and configured
- Login attempts are rate-limited to 1 per 20 seconds
- Only returns posts from the first page (approximately 20-25 items)
- Cookies are securely cached to avoid repeated authentication
- Post content shown is preview only - full content requires visiting the post link

### Privacy

Your credentials are used only to authenticate with Blind and are never stored permanently. Session cookies are cached in your RSSHub cache (Redis or memory) for 7 days.
