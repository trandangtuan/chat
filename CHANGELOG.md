# Changelog

All notable changes to the TDShift Chat AI app are recorded here.

Time zone: Asia/Ho_Chi_Minh (UTC+07:00).

## Unreleased

### 2026-08-09

#### Added

- Show each user's token usage summary and recent request history in Settings.
- Load `/api/usage/token-history?limit=50` when the workspace starts.
- Refresh token usage after each streamed assistant response completes.
- Add a Settings menu with separate MCP, Skills, Rules, Memory, and Token usage views.
- Move Settings into a sidebar button above Sign out and show settings views in a dialog.
- Add skill descriptions and select relevant skills by name/description before injecting detailed skill instructions.
- Add shareable live chat embeds with public widget sessions that reuse the owner's MCP servers, skills, rules, and memory.
- Redesign the live chat widget launcher and panel for clearer modern UX across external websites.
- Use an icon-only live chat launcher with optional per-share PNG icon URLs.
- Add authenticated PNG uploads for live chat launcher icons.
- Add delete action for live chat shares.
- Add website sitemap indexing and retrieval-augmented answers inside the chat service.

## 2026-08-09 16:17:53 +0700 - `d8c89e3`

### Added

- Discover MCP OAuth protected resource metadata from the MCP server URL.
- Discover OAuth authorization server metadata before starting MCP OAuth.
- Dynamically register an OAuth client through the MCP server `registration_endpoint`.
- Store MCP OAuth `client_id`, optional `client_secret`, authorize URL, token URL, and granted scope per user MCP server.

### Changed

- MCP Connect no longer relies on a fixed `MCP_OAUTH_CLIENT_ID` when the MCP server supports dynamic client registration.
- `MCP_OAUTH_CLIENT_ID` is now documented as an optional fallback only.
- MCP OAuth token exchange now uses the saved client information for that user's MCP server.

### Fixed

- Fixed OAuth error `Authorization request rejected: The client does not exist on this server` for MCP servers that require dynamic client registration, such as `https://maiphong.vn/mcp`.

## 2026-08-09 16:09:38 +0700 - `0730ac4`

### Added

- Display tools exposed by connected MCP servers.
- Refresh and cache MCP tool metadata per user MCP server.
- Convert connected MCP tools into OpenRouter tool definitions.
- Execute selected MCP tools server-side during OpenRouter chat completion.

## 2026-08-09 16:04:19 +0700 - `756256d`

### Added

- Generate MCP OAuth Authorization Code + PKCE authorize URLs from the MCP server URL.
- Include `resource`, `state`, `code_challenge`, and `code_challenge_method=S256` in MCP OAuth authorization requests.
- Store MCP OAuth state, code verifier, redirect URI, and resource for callback verification.

## 2026-08-09 15:56:06 +0700 - `ab2dcf8`

### Changed

- Refined MCP browser connect flow to match ChatGPT/Claude style.
- Removed manual OAuth authorize URL and token URL fields from the UI.
- Kept the Connect action as the single browser sign-in entry point for OAuth and Mixed MCP servers.

## 2026-08-09 15:45:17 +0700 - `e8c7dbf`

### Added

- Added MCP OAuth callback route.
- Added server-side OAuth code exchange for MCP server connections.
- Save MCP access token, refresh token, and expiry after successful connection.

## 2026-08-09 15:11:51 +0700 - `06a5eef`

### Added

- Added Settings view for MCP server list.
- Added per-user Rules for durable assistant behavior instructions.
- Added per-user Memory for persistent user and project context.
- Include enabled rules, memories, skills, and MCP server metadata in the server-side AI system prompt.

## 2026-08-09 14:51:07 +0700 - `2ccce93`

### Added

- Added New Plugin form in Settings for custom MCP servers.
- Added MCP connection type, authentication type, server URL, name, description, and icon fields.
- Added OAuth, No Auth, and Mixed authentication choices.

## 2026-08-09 05:00:08 +0700 - `da91024`

### Fixed

- Fixed missing React imports in split frontend components.
- Resolved `React is not defined` runtime errors after component refactor.

## 2026-08-09 04:43:54 +0700 - `caa0d08`

### Changed

- Refactored the React UI into separate components.
- Split sidebar, chat panel, login screen, and settings panel code.
- Adjusted layout CSS so only the chat message area scrolls.

## 2026-08-09 04:29:41 +0700 - `679533a`

### Added

- Added streaming assistant responses in the chat UI.
- Added a visible Thinking state while waiting for streamed model output.
- Added server-side streaming route for OpenRouter responses.

## 2026-08-09 03:28:58 +0700 - `b845e47`

### Added

- Built the initial multi-user AI chat app.
- Added SSO OAuth login through `https://auth.tdshift.info`.
- Added server-side OpenRouter API calls so API keys are not exposed in the browser.
- Added per-user conversations and messages.
- Added per-user skills.
- Added token usage storage in SQLite for future billing features.
- Added base Express server, React/Vite frontend, SQLite persistence, and production build configuration.
