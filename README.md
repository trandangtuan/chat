# TDShift Chat AI

Node.js ChatGPT-style multi-user chat app.

- SSO OAuth login through `https://auth.tdshift.info`
- Private conversations and messages per authenticated user
- Personal MCP server registry per user
- Personal skill instructions per user
- OpenRouter chat completions from the server with `OPENROUTER_API_KEY`; otherwise the app returns a local development response

## Run Locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL for the frontend. API runs on `PORT` from `.env`.

OpenRouter is called only from `server/ai.js`, so the API key stays on the backend and is never exposed to the browser.

## Production

Set the same OAuth secret in both services:

- `auth/.env`: `OAUTH_CHAT_CLIENT_SECRET=...`
- `chat/.env`: `OAUTH_CLIENT_SECRET=...`

Set the OpenRouter key on the chat server:

```env
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Register this callback in Auth Service:

```text
https://chat.tdshift.info/auth/callback
```

Build and run:

```bash
docker compose up --build -d
```

## Data Ownership

Every table that stores user content includes `user_id`, and every API query is scoped by the SSO-authenticated user. Conversations, messages, MCP servers, and skills are isolated by user.

## Token Usage

The server stores token history in `token_usage` after every assistant response. Records include `user_id`, `conversation_id`, `message_id`, provider, model, prompt tokens, completion tokens, total tokens, and the raw provider usage payload.

Authenticated users can inspect their own usage with:

```text
GET /api/usage/token-history?limit=100
```

This endpoint returns both detailed rows and a grouped summary by provider/model, ready for a future billing layer.
