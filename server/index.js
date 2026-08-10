import express from 'express'
import crypto from 'node:crypto'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config } from './config.js'
import { db } from './db.js'
import { authRoutes, requireUser } from './auth.js'
import { generateAssistantReply, streamAssistantReply } from './ai.js'
import { listMcpTools, refreshMcpToolsForServer } from './mcp.js'

const app = express()

app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ origin: config.appUrl, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser(config.sessionSecret))

authRoutes(app)

app.get('/api/conversations', requireUser, (req, res) => {
  const conversations = db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.user.id)
  res.json({ conversations })
})

app.post('/api/conversations', requireUser, (req, res) => {
  const title = z.object({ title: z.string().min(1).max(120).optional() }).parse(req.body).title || 'New chat'
  const id = nanoid()
  db.prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)').run(id, req.user.id, title)
  res.status(201).json({ conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) })
})

app.get('/api/conversations/:id/messages', requireUser, (req, res) => {
  assertOwnsConversation(req.user.id, req.params.id)
  const messages = db.prepare(`
    SELECT id, role, content, created_at
    FROM messages
    WHERE conversation_id = ? AND user_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id, req.user.id)
  res.json({ messages })
})

app.post('/api/conversations/:id/messages', requireUser, async (req, res, next) => {
  try {
    assertOwnsConversation(req.user.id, req.params.id)
    const { content } = z.object({ content: z.string().min(1).max(20000) }).parse(req.body)
    const userMessageId = nanoid()
    db.prepare('INSERT INTO messages (id, conversation_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)')
      .run(userMessageId, req.params.id, req.user.id, 'user', content)

    const messages = db.prepare(`
      SELECT role, content
      FROM messages
      WHERE conversation_id = ? AND user_id = ?
      ORDER BY created_at ASC
    `).all(req.params.id, req.user.id)
    const skills = listSkills(req.user.id)
    const mcpServers = listMcpServers(req.user.id)
    const rules = listRules(req.user.id)
    const memories = listMemories(req.user.id)
    const assistant = await generateAssistantReply({ user: req.user, messages, skills, mcpServers, rules, memories })
    const assistantMessageId = nanoid()
    db.prepare('INSERT INTO messages (id, conversation_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)')
      .run(assistantMessageId, req.params.id, req.user.id, 'assistant', assistant.content)
    recordTokenUsage({
      userId: req.user.id,
      conversationId: req.params.id,
      messageId: assistantMessageId,
      usage: assistant.usage
    })
    db.prepare('UPDATE conversations SET title = CASE WHEN title = ? THEN ? ELSE title END, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('New chat', content.slice(0, 80), req.params.id)
    res.status(201).json({
      messages: [
        { id: userMessageId, role: 'user', content },
        { id: assistantMessageId, role: 'assistant', content: assistant.content }
      ],
      usage: assistant.usage
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/conversations/:id/messages/stream', requireUser, async (req, res, next) => {
  let streamStarted = false
  try {
    assertOwnsConversation(req.user.id, req.params.id)
    const { content } = z.object({ content: z.string().min(1).max(20000) }).parse(req.body)
    const userMessageId = nanoid()
    const assistantMessageId = nanoid()
    db.prepare('INSERT INTO messages (id, conversation_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)')
      .run(userMessageId, req.params.id, req.user.id, 'user', content)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    streamStarted = true
    writeSse(res, 'start', { userMessageId, assistantMessageId })

    const messages = db.prepare(`
      SELECT role, content
      FROM messages
      WHERE conversation_id = ? AND user_id = ?
      ORDER BY created_at ASC
    `).all(req.params.id, req.user.id)
    const skills = listSkills(req.user.id)
    const mcpServers = listMcpServers(req.user.id)
    const rules = listRules(req.user.id)
    const memories = listMemories(req.user.id)
    const assistant = await streamAssistantReply({
      user: req.user,
      messages,
      skills,
      mcpServers,
      rules,
      memories,
      onDelta: async (delta) => writeSse(res, 'delta', { delta })
    })

    db.prepare('INSERT INTO messages (id, conversation_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)')
      .run(assistantMessageId, req.params.id, req.user.id, 'assistant', assistant.content)
    recordTokenUsage({
      userId: req.user.id,
      conversationId: req.params.id,
      messageId: assistantMessageId,
      usage: assistant.usage
    })
    db.prepare('UPDATE conversations SET title = CASE WHEN title = ? THEN ? ELSE title END, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('New chat', content.slice(0, 80), req.params.id)
    writeSse(res, 'done', {
      userMessage: { id: userMessageId, role: 'user', content },
      assistantMessage: { id: assistantMessageId, role: 'assistant', content: assistant.content },
      usage: assistant.usage
    })
    res.end()
  } catch (error) {
    if (streamStarted) {
      writeSse(res, 'error', { error: error.message || 'STREAM_FAILED' })
      res.end()
      return
    }
    next(error)
  }
})

app.get('/api/mcp-servers', requireUser, (req, res) => {
  res.json({ mcpServers: listMcpServers(req.user.id) })
})

app.post('/api/mcp-servers', requireUser, (req, res) => {
  const payload = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(300).optional().nullable(),
    iconUrl: z.string().max(500).optional().nullable(),
    connectionType: z.enum(['server_url', 'tunnel']).default('server_url'),
    authType: z.enum(['oauth', 'no_auth', 'mixed']).default('oauth'),
    transport: z.enum(['stdio', 'http', 'sse']).default('sse'),
    command: z.string().max(500).optional().nullable(),
    url: z.string().max(500).optional().nullable(),
    env: z.record(z.string()).default({}),
    enabled: z.boolean().default(true)
  }).parse(req.body)
  if (payload.authType !== 'no_auth' && !payload.url) {
    return res.status(400).json({ error: 'MCP_SERVER_URL_REQUIRED' })
  }
  const id = nanoid()
  const connectionStatus = payload.authType === 'no_auth' ? 'connected' : 'pending'
  db.prepare(`
    INSERT INTO mcp_servers (
      id, user_id, name, description, icon_url, connection_type, auth_type,
      connection_status, transport, command, url, env_json, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.user.id,
    payload.name,
    payload.description,
    payload.iconUrl,
    payload.connectionType,
    payload.authType,
    connectionStatus,
    payload.transport,
    payload.command,
    payload.url,
    JSON.stringify(payload.env),
    payload.enabled ? 1 : 0
  )
  res.status(201).json({ mcpServer: normalizeMcpServer(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)) })
})

app.post('/api/mcp-servers/:id/connect', requireUser, async (req, res, next) => {
  try {
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
    if (!server) return res.status(404).json({ error: 'MCP_SERVER_NOT_FOUND' })
    if (server.auth_type === 'no_auth') {
      db.prepare('UPDATE mcp_servers SET connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('connected', server.id)
      return res.json({ connected: true })
    }
    if (!server.url) {
      return res.status(400).json({
        error: 'MCP_SERVER_URL_REQUIRED',
        message: 'OAuth/Mixed MCP servers require a server URL.'
      })
    }

    const state = `oauth_s_${crypto.randomBytes(16).toString('hex')}`
    const codeVerifier = crypto.randomBytes(64).toString('base64url')
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const redirectUri = `${config.appUrl}/api/mcp/oauth/callback`
    const metadata = await discoverMcpOAuth(server.url)
    const client = await ensureMcpOAuthClient(server, metadata, redirectUri)
    db.prepare(`
      INSERT INTO mcp_oauth_states (state, user_id, mcp_server_id, code_verifier, redirect_uri, resource)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(state, req.user.id, server.id, codeVerifier, redirectUri, metadata.resource)

    const authUrl = new URL(metadata.authorizationEndpoint)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', client.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', client.scope || config.mcpOAuthScopes)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('resource', metadata.resource)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('ui_locales', config.mcpOAuthUiLocales)
    res.json({ authUrl: authUrl.toString() })
  } catch (error) {
    next(error)
  }
})

app.post('/api/mcp-servers/:id/tools/refresh', requireUser, async (req, res, next) => {
  try {
    const tools = await refreshMcpToolsForServer(req.user.id, req.params.id)
    res.json({ tools })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/mcp-servers/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'MCP_SERVER_NOT_FOUND' })
  res.json({ ok: true })
})

app.get('/api/mcp/oauth/callback', async (req, res, next) => {
  try {
    const state = String(req.query.state || '')
    const code = String(req.query.code || '')
    const storedState = db.prepare('SELECT * FROM mcp_oauth_states WHERE state = ?').get(state)
    if (!storedState || !code) return res.status(400).send('Invalid MCP OAuth callback')
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
      .get(storedState.mcp_server_id, storedState.user_id)
    if (!server) return res.status(404).send('MCP server not found')

    const tokenPayload = await exchangeMcpOAuthCode(server, storedState, code)
    db.prepare(`
      UPDATE mcp_servers
      SET connection_status = ?, oauth_access_token = ?, oauth_refresh_token = ?,
          oauth_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      'connected',
      tokenPayload.access_token || code,
      tokenPayload.refresh_token || null,
      tokenPayload.expires_in ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000).toISOString() : null,
      server.id
    )
    db.prepare('DELETE FROM mcp_oauth_states WHERE state = ?').run(state)
    await refreshMcpToolsForServer(storedState.user_id, server.id).catch((error) => {
      console.error('MCP tools refresh failed after OAuth callback', error)
    })
    res.redirect(303, config.appUrl)
  } catch (error) {
    next(error)
  }
})

app.get('/api/skills', requireUser, (req, res) => {
  res.json({ skills: listSkills(req.user.id) })
})

app.get('/api/rules', requireUser, (req, res) => {
  res.json({ rules: listRules(req.user.id) })
})

app.post('/api/rules', requireUser, (req, res) => {
  const payload = z.object({
    title: z.string().min(1).max(80),
    instruction: z.string().min(1).max(10000),
    enabled: z.boolean().default(true)
  }).parse(req.body)
  const id = nanoid()
  db.prepare('INSERT INTO rules (id, user_id, title, instruction, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, payload.title, payload.instruction, payload.enabled ? 1 : 0)
  res.status(201).json({ rule: db.prepare('SELECT * FROM rules WHERE id = ?').get(id) })
})

app.get('/api/memories', requireUser, (req, res) => {
  res.json({ memories: listMemories(req.user.id) })
})

app.post('/api/memories', requireUser, (req, res) => {
  const payload = z.object({
    title: z.string().min(1).max(80),
    content: z.string().min(1).max(10000),
    enabled: z.boolean().default(true)
  }).parse(req.body)
  const id = nanoid()
  db.prepare('INSERT INTO memories (id, user_id, title, content, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, payload.title, payload.content, payload.enabled ? 1 : 0)
  res.status(201).json({ memory: db.prepare('SELECT * FROM memories WHERE id = ?').get(id) })
})

app.get('/api/usage/token-history', requireUser, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500)
  const rows = db.prepare(`
    SELECT id, conversation_id, message_id, provider, model, prompt_tokens,
           completion_tokens, total_tokens, created_at
    FROM token_usage
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(req.user.id, limit)
  const summary = db.prepare(`
    SELECT provider, model,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS request_count
    FROM token_usage
    WHERE user_id = ?
    GROUP BY provider, model
    ORDER BY total_tokens DESC
  `).all(req.user.id)
  res.json({ usage: rows, summary })
})

app.post('/api/skills', requireUser, (req, res) => {
  const payload = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional().nullable(),
    instructions: z.string().min(1).max(10000),
    enabled: z.boolean().default(true)
  }).parse(req.body)
  const id = nanoid()
  db.prepare('INSERT INTO skills (id, user_id, name, description, instructions, enabled) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, payload.name, payload.description || null, payload.instructions, payload.enabled ? 1 : 0)
  res.status(201).json({ skill: db.prepare('SELECT * FROM skills WHERE id = ?').get(id) })
})

app.use(express.static('dist'))
app.get('*', (_req, res) => res.sendFile(new URL('../dist/index.html', import.meta.url).pathname))

app.use((error, _req, res, _next) => {
  if (error?.name === 'ZodError') return res.status(400).json({ error: 'VALIDATION_ERROR', details: error.errors })
  if (error?.status) return res.status(error.status).json({ error: error.message })
  console.error(error)
  res.status(500).json({ error: 'INTERNAL_ERROR' })
})

app.listen(config.port, () => {
  console.log(`TDShift Chat AI listening on :${config.port}`)
})

function assertOwnsConversation(userId, conversationId) {
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId)
  if (!conversation) {
    const error = new Error('CONVERSATION_NOT_FOUND')
    error.status = 404
    throw error
  }
}

function listSkills(userId) {
  return db.prepare('SELECT id, name, description, instructions, enabled, created_at, updated_at FROM skills WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((skill) => ({ ...skill, enabled: Boolean(skill.enabled) }))
}

function listRules(userId) {
  return db.prepare('SELECT id, title, instruction, enabled, created_at, updated_at FROM rules WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((rule) => ({ ...rule, enabled: Boolean(rule.enabled) }))
}

function listMemories(userId) {
  return db.prepare('SELECT id, title, content, enabled, created_at, updated_at FROM memories WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((memory) => ({ ...memory, enabled: Boolean(memory.enabled) }))
}

function listMcpServers(userId) {
  return db.prepare(`
    SELECT id, user_id, name, description, icon_url, connection_type, auth_type,
           connection_status, transport, command, url, env_json, enabled, created_at, updated_at
    FROM mcp_servers
    WHERE user_id = ?
    ORDER BY created_at DESC
  `)
    .all(userId)
    .map(normalizeMcpServer)
}

function recordTokenUsage({ userId, conversationId, messageId, usage }) {
  const safeUsage = usage || {}
  db.prepare(`
    INSERT INTO token_usage (
      id, user_id, conversation_id, message_id, provider, model,
      prompt_tokens, completion_tokens, total_tokens, raw_usage_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    userId,
    conversationId,
    messageId,
    safeUsage.provider || 'unknown',
    safeUsage.model || 'unknown',
    Number(safeUsage.promptTokens || 0),
    Number(safeUsage.completionTokens || 0),
    Number(safeUsage.totalTokens || 0),
    JSON.stringify(safeUsage.raw || {})
  )
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function exchangeMcpOAuthCode(server, storedState, code) {
  const tokenUrl = server.oauth_token_url || deriveMcpOAuthUrl(server.url, 'token').toString()
  const clientId = server.oauth_client_id || config.mcpOAuthClientId
  if (!clientId) throw new Error('MCP_OAUTH_CLIENT_NOT_REGISTERED')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: storedState.redirect_uri,
    client_id: clientId,
    code_verifier: storedState.code_verifier,
    resource: storedState.resource
  })
  if (server.oauth_client_secret) body.set('client_secret', server.oauth_client_secret)
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('MCP OAuth token exchange failed', response.status, detail)
    throw new Error('MCP_OAUTH_TOKEN_EXCHANGE_FAILED')
  }
  return response.json()
}

async function discoverMcpOAuth(serverUrl) {
  const resource = normalizeMcpResource(serverUrl)
  const fallback = {
    authorizationEndpoint: deriveMcpOAuthUrl(serverUrl, 'authorize').toString(),
    tokenEndpoint: deriveMcpOAuthUrl(serverUrl, 'token').toString(),
    registrationEndpoint: null,
    resource
  }
  const resourceMetadata = await fetchOptionalJson(buildProtectedResourceMetadataUrl(serverUrl))
  const authorizationServer = resourceMetadata?.authorization_servers?.[0]
  const authServerMetadataUrl = authorizationServer
    ? buildAuthorizationServerMetadataUrl(authorizationServer)
    : buildAuthorizationServerMetadataUrl(new URL(serverUrl).origin)
  const authMetadata = await fetchOptionalJson(authServerMetadataUrl)

  return {
    authorizationEndpoint: authMetadata?.authorization_endpoint || fallback.authorizationEndpoint,
    tokenEndpoint: authMetadata?.token_endpoint || fallback.tokenEndpoint,
    registrationEndpoint: authMetadata?.registration_endpoint || fallback.registrationEndpoint,
    resource: resourceMetadata?.resource || resource
  }
}

async function ensureMcpOAuthClient(server, metadata, redirectUri) {
  if (server.oauth_client_id) {
    return {
      clientId: server.oauth_client_id,
      clientSecret: server.oauth_client_secret,
      scope: server.oauth_scope
    }
  }
  if (!metadata.registrationEndpoint) {
    if (!config.mcpOAuthClientId) throw new Error('MCP_OAUTH_CLIENT_NOT_REGISTERED')
    return { clientId: config.mcpOAuthClientId, clientSecret: null, scope: config.mcpOAuthScopes }
  }

  const response = await fetch(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: config.openrouterAppName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: config.mcpOAuthScopes
    })
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('MCP OAuth dynamic client registration failed', response.status, detail)
    throw new Error('MCP_OAUTH_CLIENT_REGISTRATION_FAILED')
  }
  const payload = await response.json()
  if (!payload.client_id) throw new Error('MCP_OAUTH_CLIENT_REGISTRATION_FAILED')

  db.prepare(`
    UPDATE mcp_servers
    SET oauth_authorize_url = ?, oauth_token_url = ?, oauth_client_id = ?,
        oauth_client_secret = ?, oauth_scope = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    metadata.authorizationEndpoint,
    metadata.tokenEndpoint,
    payload.client_id,
    payload.client_secret || null,
    payload.scope || config.mcpOAuthScopes,
    server.id
  )

  return {
    clientId: payload.client_id,
    clientSecret: payload.client_secret || null,
    scope: payload.scope || config.mcpOAuthScopes
  }
}

async function fetchOptionalJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return response.json()
  } catch (error) {
    console.warn('MCP OAuth metadata discovery failed', url, error.message)
    return null
  }
}

function buildProtectedResourceMetadataUrl(serverUrl) {
  const url = new URL(serverUrl)
  const metadata = new URL('/.well-known/oauth-protected-resource', url.origin)
  metadata.pathname = `${metadata.pathname}${url.pathname.replace(/\/$/, '')}`
  return metadata.toString()
}

function buildAuthorizationServerMetadataUrl(issuerUrl) {
  const url = new URL(issuerUrl)
  const issuerPath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  url.pathname = `${issuerPath}/.well-known/oauth-authorization-server`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function deriveMcpOAuthUrl(serverUrl, endpoint) {
  const url = new URL(serverUrl)
  const basePath = url.pathname.replace(/\/$/, '')
  url.pathname = `${basePath}/oauth/${endpoint}`
  url.search = ''
  url.hash = ''
  return url
}

function normalizeMcpResource(serverUrl) {
  const url = new URL(serverUrl)
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function normalizeMcpServer(server) {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    iconUrl: server.icon_url,
    connectionType: server.connection_type,
    authType: server.auth_type,
    connectionStatus: server.connection_status,
    transport: server.transport,
    command: server.command,
    url: server.url,
    tools: listMcpTools(server.user_id, server.id),
    env: JSON.parse(server.env_json || '{}'),
    enabled: Boolean(server.enabled),
    created_at: server.created_at,
    updated_at: server.updated_at
  }
}
