# SpoFlix

SpoFlix is a music player with a Windows desktop build and a static web version.

## Windows app

- `npm start` opens the Electron development build.
- `npm run dist` creates the Windows installer in `release/`.
- The local server uses port `45678` and serves the app and audio proxy.

The local YouTube Data API key is read from the ignored `local-secrets.json` file or the `YOUTUBE_DATA_API_KEY` environment variable. Keep this file out of GitHub.

## Vercel website

The project serves `index.html`, `app.js`, and `style.css` directly. The `/api/youtube` function searches YouTube with a server-side key, and `/api/stream` relays supported audio preview hosts with byte-range support.

1. Import the GitHub repository into Vercel.
2. Set the `YOUTUBE_DATA_API_KEY` environment variable in Vercel Project Settings.
3. Redeploy so the function can use the key.

The project does not need a frontend build step. `local-secrets.json`, `.env` files, and desktop build output are excluded from the GitHub and Vercel uploads.
