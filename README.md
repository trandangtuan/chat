# TDShift Chat AI

Node.js ChatGPT-style multi-user chat app.

- SSO OAuth login through `https://auth.tdshift.info`
- Private conversations and messages per authenticated user
- Personal MCP server registry per user
- Personal skills per user, with lightweight name/description selection before detailed instructions are injected
- Personal rules and memory per user
- OpenRouter chat completions from the server with `OPENROUTER_API_KEY`; otherwise the app returns a local development response
- Streaming assistant responses with a `Thinking...` state while the first token is pending

## Run Locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL for the frontend. API runs on `PORT` from `.env`.

OpenRouter is called only from `server/ai.js`, so the API key stays on the backend and is never exposed to the browser.

The chat UI posts to `POST /api/conversations/:id/messages/stream` and reads server-sent events for token deltas. The non-streaming JSON endpoint remains available at `POST /api/conversations/:id/messages`.

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

Every table that stores user content includes `user_id`, and every API query is scoped by the SSO-authenticated user. Conversations, messages, MCP servers, rules, memory, and skills are isolated by user.

## Token Usage

The server stores token history in `token_usage` after every assistant response. Records include `user_id`, `conversation_id`, `message_id`, provider, model, prompt tokens, completion tokens, total tokens, and the raw provider usage payload.

Authenticated users can inspect their own usage with:

```text
GET /api/usage/token-history?limit=100
```

This endpoint returns both detailed rows and a grouped summary by provider/model, ready for a future billing layer.
