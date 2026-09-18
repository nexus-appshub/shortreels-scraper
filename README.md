# ShortReels Scraper

A Node.js + Playwright service for discovering short-reel media from public/authorized web pages and exposing a continuously growing feed to an Android client.

## What it does

- Opens a reel/short-video feed in Playwright.
- Watches DOM, fetch/XHR responses, and media requests.
- Extracts public media candidates such as HLS .m3u8, DASH .mpd, and direct .mp4 URLs.
- Extracts reel metadata from JSON API responses when available.
- Deduplicates results.
- Keeps a browser session alive so repeated /v1/feed calls can advance the page and return newly discovered reels.
- Includes provider adapters for GoodShort and DashReels-style pages, plus a generic fallback.

## Scope

Use this only for content you are authorized to access and process. The scraper does not bypass DRM, login controls, signed-access restrictions, CAPTCHAs, or other access controls.

## Run

```bash
npm install
npx playwright install chromium
npm start
```

Health: GET /health

Start/continue a feed:
GET /v1/feed?url=https%3A%2F%2Fexample.com%2Freels&limit=10

The first response returns a sessionId. Send that sessionId on subsequent calls to continue scrolling and discover newly observed reels.

## Android

The Android client can request the first feed page, render returned items, and request the same sessionId when the user approaches the end of the list. Use Android Media3/ExoPlayer for HLS/DASH/MP4 where the returned media URL is legitimately playable.

## Provider adapters

GoodShort, DashReels-style, and generic fallback adapters live under src/providers/. Provider structures can change, so adapters are intentionally isolated.
