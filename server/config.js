import dotenv from 'dotenv'

dotenv.config()

export const config = {
  port: Number(process.env.PORT || 8001),
  appUrl: process.env.APP_URL || 'https://chat.tdshift.info',
  authBaseUrl: process.env.AUTH_BASE_URL || 'https://auth.tdshift.info',
  oauthClientId: process.env.OAUTH_CLIENT_ID || 'chat-ai',
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET || '',
  oauthRedirectUri: process.env.OAUTH_REDIRECT_URI || 'https://chat.tdshift.info/auth/callback',
  mcpOAuthClientId: process.env.MCP_OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_ID || 'chat-ai',
  mcpOAuthScopes: process.env.MCP_OAUTH_SCOPES || 'mcp mcp:read mcp:write',
  mcpOAuthUiLocales: process.env.MCP_OAUTH_UI_LOCALES || 'en-US',
  sessionSecret: process.env.SESSION_SECRET || 'development-session-secret-change-me',
  databasePath: process.env.DATABASE_PATH || './data/chat.db',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL || process.env.APP_URL || 'https://chat.tdshift.info',
  openrouterAppName: process.env.OPENROUTER_APP_NAME || 'TDShift Chat AI',
  cookieSecure: (process.env.APP_URL || '').startsWith('https://')
}
