import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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
import { buildWebsiteContextBlock, indexWebsiteSource, normalizeWebsiteUrl, searchWebsiteContext } from './websiteRag.js'

const app = express()
const publicDir = path.resolve('public')
const liveChatIconDir = path.join(publicDir, 'uploads', 'live-chat-icons')
fs.mkdirSync(liveChatIconDir, { recursive: true })

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}))
app.use(cors((req, callback) => {
  if (req.path.startsWith('/api/live-chat') || req.path.startsWith('/live-chat')) {
    callback(null, { origin: true, credentials: false })
    return
  }
  callback(null, { origin: config.appUrl, credentials: true })
}))
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
    const websiteContext = await buildWebsiteContext(req.user.id, content)
    const assistant = await generateAssistantReply({ user: req.user, messages, skills, mcpServers, rules, memories, websiteContext })
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
    const websiteContext = await buildWebsiteContext(req.user.id, content)
    const assistant = await streamAssistantReply({
      user: req.user,
      messages,
      skills,
      mcpServers,
      rules,
      memories,
      websiteContext,
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

app.get('/api/website-sources', requireUser, (req, res) => {
  res.json({ sources: listWebsiteSources(req.user.id) })
})

app.get('/api/website-sources/:id/pages', requireUser, (req, res) => {
  const source = db.prepare('SELECT id FROM website_sources WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
  if (!source) return res.status(404).json({ error: 'WEBSITE_SOURCE_NOT_FOUND' })
  const limit = Math.min(Number(req.query.limit || 100), 500)
  const pages = db.prepare(`
    SELECT id, url, title, chunk_index AS chunkIndex, content, length(content) AS contentLength, created_at
    FROM website_pages
    WHERE source_id = ? AND user_id = ?
    ORDER BY title ASC, chunk_index ASC
    LIMIT ?
  `).all(req.params.id, req.user.id, limit)
  res.json({ pages })
})

app.post('/api/website-sources', requireUser, async (req, res, next) => {
  try {
    const payload = z.object({
      url: z.string().min(3).max(500),
      enabled: z.boolean().default(true)
    }).parse(req.body)
    const id = nanoid()
    const url = normalizeWebsiteUrl(payload.url)
    db.prepare(`
      INSERT INTO website_sources (id, user_id, url, status, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.user.id, url, 'indexing', payload.enabled ? 1 : 0)

    try {
      const result = await indexWebsiteSource({ userId: req.user.id, sourceId: id, url })
      db.prepare(`
        UPDATE website_sources
        SET status = ?, page_count = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run('ready', result.indexed || 0, id, req.user.id)
    } catch (error) {
      db.prepare(`
        UPDATE website_sources
        SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run('error', error.message.slice(0, 500), id, req.user.id)
    }

    res.status(201).json({ source: normalizeWebsiteSource(db.prepare('SELECT * FROM website_sources WHERE id = ? AND user_id = ?').get(id, req.user.id)) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/website-sources/:id/refresh', requireUser, async (req, res, next) => {
  try {
    const source = db.prepare('SELECT * FROM website_sources WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
    if (!source) return res.status(404).json({ error: 'WEBSITE_SOURCE_NOT_FOUND' })
    db.prepare('UPDATE website_sources SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .run('indexing', source.id, req.user.id)
    const result = await indexWebsiteSource({ userId: req.user.id, sourceId: source.id, url: source.url })
    db.prepare(`
      UPDATE website_sources
      SET status = ?, page_count = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run('ready', result.indexed || 0, source.id, req.user.id)
    res.json({ source: normalizeWebsiteSource(db.prepare('SELECT * FROM website_sources WHERE id = ? AND user_id = ?').get(source.id, req.user.id)) })
  } catch (error) {
    db.prepare('UPDATE website_sources SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .run('error', error.message.slice(0, 500), req.params.id, req.user.id)
    next(error)
  }
})

app.delete('/api/website-sources/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM website_sources WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'WEBSITE_SOURCE_NOT_FOUND' })
  db.prepare('DELETE FROM website_pages_fts WHERE source_id = ? AND user_id = ?').run(req.params.id, req.user.id)
  res.json({ ok: true })
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

app.get('/api/live-chat-shares', requireUser, (req, res) => {
  const shares = db.prepare(`
    SELECT id, share_key, name, allowed_origin, icon_url, enabled, created_at, updated_at
    FROM live_chat_shares
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id).map(normalizeLiveChatShare)
  res.json({ shares })
})

app.post('/api/live-chat-icons', requireUser, readRawBody({ limit: 256 * 1024 }), (req, res) => {
  const upload = parseSingleMultipartFile(req)
  if (!upload) return res.status(400).json({ error: 'ICON_FILE_REQUIRED' })
  if (upload.contentType !== 'image/png' || !isPng(upload.buffer)) {
    return res.status(400).json({ error: 'PNG_ICON_REQUIRED' })
  }
  const filename = `${req.user.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${crypto.randomBytes(12).toString('hex')}.png`
  const diskPath = path.join(liveChatIconDir, filename)
  fs.writeFileSync(diskPath, upload.buffer)
  res.status(201).json({ iconUrl: `${config.appUrl}/uploads/live-chat-icons/${filename}` })
})

app.post('/api/live-chat-shares', requireUser, (req, res) => {
  const payload = z.object({
    name: z.string().min(1).max(120),
    allowedOrigin: z.string().max(300).optional().nullable(),
    iconUrl: z.string().max(500).optional().nullable()
  }).parse(req.body)
  const id = nanoid()
  const shareKey = `lc_${crypto.randomBytes(18).toString('base64url')}`
  db.prepare(`
    INSERT INTO live_chat_shares (id, user_id, share_key, name, allowed_origin, icon_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, shareKey, payload.name, payload.allowedOrigin || null, payload.iconUrl || null)
  const share = db.prepare('SELECT id, share_key, name, allowed_origin, icon_url, enabled, created_at, updated_at FROM live_chat_shares WHERE id = ?').get(id)
  res.status(201).json({ share: normalizeLiveChatShare(share) })
})

app.delete('/api/live-chat-shares/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM live_chat_shares WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'LIVE_CHAT_SHARE_NOT_FOUND' })
  res.json({ ok: true })
})

app.get('/live-chat/widget.js', (req, res) => {
  res.type('application/javascript').send(buildLiveChatWidgetScript(String(req.query.key || '')))
})

app.post('/api/live-chat/:shareKey/session', (req, res) => {
  const share = getLiveChatShare(req.params.shareKey)
  if (!share) return res.status(404).json({ error: 'LIVE_CHAT_SHARE_NOT_FOUND' })
  if (!isAllowedLiveChatOrigin(share, req.body?.origin || req.get('origin'))) {
    return res.status(403).json({ error: 'LIVE_CHAT_ORIGIN_NOT_ALLOWED' })
  }
  const visitorKey = String(req.body?.visitorKey || crypto.randomBytes(16).toString('base64url'))
  let session = db.prepare('SELECT * FROM live_chat_sessions WHERE share_id = ? AND visitor_key = ?')
    .get(share.id, visitorKey)
  if (!session) {
    const id = nanoid()
    db.prepare(`
      INSERT INTO live_chat_sessions (id, share_id, visitor_key, page_url)
      VALUES (?, ?, ?, ?)
    `).run(id, share.id, visitorKey, String(req.body?.pageUrl || ''))
    session = db.prepare('SELECT * FROM live_chat_sessions WHERE id = ?').get(id)
  }
  const messages = listLiveChatMessages(session.id)
  res.json({ sessionId: session.id, visitorKey, messages, share: { name: share.name, iconUrl: share.icon_url } })
})

app.post('/api/live-chat/:shareKey/sessions/:sessionId/messages/stream', async (req, res, next) => {
  let streamStarted = false
  try {
    const share = getLiveChatShare(req.params.shareKey)
    if (!share) return res.status(404).json({ error: 'LIVE_CHAT_SHARE_NOT_FOUND' })
    if (!isAllowedLiveChatOrigin(share, req.body?.origin || req.get('origin'))) {
      return res.status(403).json({ error: 'LIVE_CHAT_ORIGIN_NOT_ALLOWED' })
    }
    const session = db.prepare('SELECT * FROM live_chat_sessions WHERE id = ? AND share_id = ?')
      .get(req.params.sessionId, share.id)
    if (!session) return res.status(404).json({ error: 'LIVE_CHAT_SESSION_NOT_FOUND' })
    const { content } = z.object({ content: z.string().min(1).max(20000) }).parse(req.body)
    const userMessageId = nanoid()
    const assistantMessageId = nanoid()
    db.prepare('INSERT INTO live_chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(userMessageId, session.id, 'user', content)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': req.get('origin') || '*'
    })
    streamStarted = true
    writeSse(res, 'start', { userMessageId, assistantMessageId })

    const owner = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(share.user_id)
    const messages = listLiveChatMessages(session.id).map((message) => ({ role: message.role, content: message.content }))
    const websiteContext = await buildWebsiteContext(share.user_id, content)
    const assistant = await streamAssistantReply({
      user: owner,
      messages,
      skills: listSkills(share.user_id),
      mcpServers: listMcpServers(share.user_id),
      rules: listRules(share.user_id),
      memories: listMemories(share.user_id),
      websiteContext,
      onDelta: async (delta) => writeSse(res, 'delta', { delta })
    })
    db.prepare('INSERT INTO live_chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(assistantMessageId, session.id, 'assistant', assistant.content)
    db.prepare('UPDATE live_chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(session.id)
    recordTokenUsage({ userId: share.user_id, conversationId: null, messageId: null, usage: assistant.usage })
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

app.use('/uploads', express.static(path.join(publicDir, 'uploads'), {
  immutable: true,
  maxAge: '30d'
}))
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

async function buildWebsiteContext(userId, query) {
  const sources = listWebsiteSources(userId).filter((source) => source.enabled && source.status === 'ready')
  if (!sources.length) return ''
  const matches = searchWebsiteContext({ userId, query, limit: 6 })
  return buildWebsiteContextBlock(matches)
}

function listWebsiteSources(userId) {
  return db.prepare(`
    SELECT id, user_id, url, status, page_count, error, enabled, created_at, updated_at
    FROM website_sources
    WHERE user_id = ?
    ORDER BY created_at DESC
  `)
    .all(userId)
    .map(normalizeWebsiteSource)
}

function normalizeWebsiteSource(source) {
  return {
    id: source.id,
    url: source.url,
    status: source.status,
    pageCount: source.page_count,
    error: source.error,
    enabled: Boolean(source.enabled),
    created_at: source.created_at,
    updated_at: source.updated_at
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

function listLiveChatMessages(sessionId) {
  return db.prepare(`
    SELECT id, role, content, created_at
    FROM live_chat_messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId)
}

function getLiveChatShare(shareKey) {
  return db.prepare('SELECT * FROM live_chat_shares WHERE share_key = ? AND enabled = 1').get(shareKey)
}

function normalizeLiveChatShare(share) {
  const scriptUrl = `${config.appUrl}/live-chat/widget.js?key=${encodeURIComponent(share.share_key)}`
  return {
    id: share.id,
    shareKey: share.share_key,
    name: share.name,
    allowedOrigin: share.allowed_origin,
    iconUrl: share.icon_url,
    enabled: Boolean(share.enabled),
    scriptUrl,
    scriptTag: `<script src="${scriptUrl}" defer></script>`,
    created_at: share.created_at,
    updated_at: share.updated_at
  }
}

function isAllowedLiveChatOrigin(share, origin) {
  if (!share.allowed_origin) return true
  try {
    return new URL(origin).origin === new URL(share.allowed_origin).origin
  } catch {
    return false
  }
}

function buildLiveChatWidgetScript(defaultShareKey) {
  const baseUrl = JSON.stringify(config.appUrl)
  const shareKey = JSON.stringify(defaultShareKey)
  return `
;(function () {
  var script = document.currentScript
  var baseUrl = script && script.dataset.baseUrl ? script.dataset.baseUrl : ${baseUrl}
  var shareKey = script && script.dataset.shareKey ? script.dataset.shareKey : ${shareKey}
  if (!shareKey || window.__tdshiftLiveChat) return
  window.__tdshiftLiveChat = true

  var storageKey = 'tdshift_live_chat_' + shareKey
  var visitorKey = localStorage.getItem(storageKey) || Math.random().toString(36).slice(2) + Date.now().toString(36)
  localStorage.setItem(storageKey, visitorKey)
  var sessionId = ''
  var messages = []
  var expanded = false
  var shareConfig = { name: 'Live chat', iconUrl: '' }

  var root = document.createElement('div')
  root.id = 'tdshift-live-chat'
  document.body.appendChild(root)
  var style = document.createElement('style')
  style.textContent = '#tdshift-live-chat{position:fixed;z-index:2147483647;right:22px;bottom:22px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101828}#tdshift-live-chat *{box-sizing:border-box;letter-spacing:0}#tdshift-live-chat button,#tdshift-live-chat input,#tdshift-live-chat textarea{font:inherit}#tdshift-live-chat button{cursor:pointer}#tdshift-live-chat .tlc-launcher{width:62px;height:62px;display:grid;place-items:center;border:0;border-radius:999px;padding:0;background:#155eef;color:#fff;box-shadow:0 18px 44px rgba(21,94,239,.34),0 4px 14px rgba(15,23,42,.2);font-size:24px;font-weight:900;overflow:hidden}#tdshift-live-chat .tlc-launcher:hover{background:#0f4cd2;transform:translateY(-1px)}#tdshift-live-chat .tlc-launcher img{width:100%;height:100%;object-fit:cover;display:block}#tdshift-live-chat .tlc-panel{display:grid;grid-template-rows:auto 1fr auto;width:min(410px,calc(100vw - 32px));height:min(660px,calc(100vh - 32px));border:1px solid rgba(255,255,255,.7);border-radius:18px;background:#fff;box-shadow:0 28px 90px rgba(15,23,42,.32);overflow:hidden}#tdshift-live-chat .tlc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 16px;background:linear-gradient(135deg,#155eef,#06b6d4);color:#fff}#tdshift-live-chat .tlc-brand{display:flex;align-items:center;gap:11px;min-width:0}#tdshift-live-chat .tlc-avatar{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;background:rgba(255,255,255,.18);font-size:20px;overflow:hidden}#tdshift-live-chat .tlc-avatar img{width:100%;height:100%;object-fit:cover;display:block}#tdshift-live-chat .tlc-head strong{display:block;font-size:15px;line-height:1.2}#tdshift-live-chat .tlc-head small{display:flex;align-items:center;gap:6px;color:rgba(255,255,255,.82);font-size:12px;font-weight:700}#tdshift-live-chat .tlc-dot{width:7px;height:7px;border-radius:99px;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.22)}#tdshift-live-chat .tlc-close{width:34px;height:34px;border:1px solid rgba(255,255,255,.3);border-radius:10px;background:rgba(255,255,255,.16);color:#fff;font-size:20px;line-height:1}#tdshift-live-chat .tlc-body{display:flex;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;padding:16px;background:#f4f7fb}#tdshift-live-chat .tlc-msg{max-width:86%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(15,23,42,.06)}#tdshift-live-chat .tlc-user{align-self:flex-end;border-bottom-right-radius:5px;background:#155eef;color:#fff}#tdshift-live-chat .tlc-assistant{align-self:flex-start;border-bottom-left-radius:5px;background:#fff;border:1px solid #e4e7ec;color:#101828}#tdshift-live-chat .tlc-form{display:grid;grid-template-columns:1fr 46px;gap:9px;padding:12px;background:#fff;border-top:1px solid #eaecf0}#tdshift-live-chat .tlc-form textarea{width:100%;height:46px;min-height:46px;max-height:112px;border:1px solid #d0d5dd;border-radius:12px;padding:12px 13px;background:#fff;color:#101828;resize:none;outline:none}#tdshift-live-chat .tlc-form textarea:focus{border-color:#155eef;box-shadow:0 0 0 3px rgba(21,94,239,.14)}#tdshift-live-chat .tlc-form button{height:46px;border:0;border-radius:12px;background:#155eef;color:#fff;font-weight:900;font-size:18px}#tdshift-live-chat .tlc-form button:hover{background:#0f4cd2}@media(max-width:520px){#tdshift-live-chat{right:12px;bottom:12px}#tdshift-live-chat .tlc-panel{width:calc(100vw - 24px);height:min(620px,calc(100vh - 24px))}}'
  document.head.appendChild(style)

  function render() {
    root.innerHTML = ''
    if (!expanded) {
      root.appendChild(createLauncher())
      return
    }

    var panel = document.createElement('section')
    panel.className = 'tlc-panel'
    panel.innerHTML = '<div class="tlc-head"><div class="tlc-brand"><div class="tlc-avatar">' + renderIconHtml() + '</div><div><strong>' + escapeHtml(shareConfig.name || 'Live chat') + '</strong><small><span class="tlc-dot"></span>AI assistant online</small></div></div><button class="tlc-close" type="button" aria-label="Close">×</button></div><div class="tlc-body"></div><form class="tlc-form"><textarea placeholder="Type your message" aria-label="Chat message"></textarea><button type="submit" aria-label="Send">➜</button></form>'
    panel.querySelector('.tlc-close').onclick = function () { expanded = false; render() }
    var body = panel.querySelector('.tlc-body')
    messages.forEach(function (message) {
      var bubble = document.createElement('div')
      bubble.className = 'tlc-msg ' + (message.role === 'user' ? 'tlc-user' : 'tlc-assistant')
      bubble.textContent = message.content
      body.appendChild(bubble)
    })
    var form = panel.querySelector('form')
    form.onsubmit = function (event) {
      event.preventDefault()
      var textarea = form.querySelector('textarea')
      send(textarea.value)
      textarea.value = ''
    }
    root.appendChild(panel)
    body.scrollTop = body.scrollHeight
  }

  function createLauncher() {
    var launcher = document.createElement('button')
    launcher.className = 'tlc-launcher'
    launcher.type = 'button'
    launcher.setAttribute('aria-label', 'Open live chat')
    launcher.innerHTML = renderIconHtml()
    launcher.onclick = function () { expanded = true; render() }
    return launcher
  }

  function renderIconHtml() {
    return shareConfig.iconUrl ? '<img src="' + escapeAttribute(shareConfig.iconUrl) + '" alt="">' : '✦'
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    })
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/\\u0000/g, '')
  }

  async function ensureSession() {
    if (sessionId) return
    var response = await fetch(baseUrl + '/api/live-chat/' + encodeURIComponent(shareKey) + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorKey: visitorKey, pageUrl: location.href, origin: location.origin })
    })
    if (!response.ok) throw new Error('LIVE_CHAT_SESSION_FAILED')
    var data = await response.json()
    sessionId = data.sessionId
    visitorKey = data.visitorKey
    messages = data.messages || []
    shareConfig = data.share || shareConfig
    localStorage.setItem(storageKey, visitorKey)
  }

  async function send(content) {
    content = String(content || '').trim()
    if (!content) return
    await ensureSession()
    expanded = true
    var assistant = { role: 'assistant', content: 'Thinking...' }
    messages.push({ role: 'user', content: content }, assistant)
    render()
    var response = await fetch(baseUrl + '/api/live-chat/' + encodeURIComponent(shareKey) + '/sessions/' + encodeURIComponent(sessionId) + '/messages/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content, origin: location.origin })
    })
    if (!response.ok || !response.body) throw new Error('LIVE_CHAT_STREAM_FAILED')
    var reader = response.body.getReader()
    var decoder = new TextDecoder()
    var buffer = ''
    assistant.content = ''
    while (true) {
      var chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      var blocks = buffer.split('\\n\\n')
      buffer = blocks.pop() || ''
      blocks.forEach(function (block) {
        var parsed = parseEvent(block)
        if (parsed.event === 'delta') {
          assistant.content += parsed.data.delta || ''
          render()
        }
        if (parsed.event === 'done') {
          messages[messages.length - 2] = parsed.data.userMessage
          messages[messages.length - 1] = parsed.data.assistantMessage
          render()
        }
      })
    }
  }

  function parseEvent(block) {
    var event = 'message'
    var data = []
    block.split('\\n').forEach(function (line) {
      if (line.indexOf('event:') === 0) event = line.slice(6).trim()
      if (line.indexOf('data:') === 0) data.push(line.slice(5).trim())
    })
    return { event: event, data: data.length ? JSON.parse(data.join('\\n')) : null }
  }

  ensureSession().then(render).catch(render)
})()
`
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

function readRawBody({ limit }) {
  return (req, res, next) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        res.status(413).json({ error: 'UPLOAD_TOO_LARGE' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks)
      next()
    })
    req.on('error', next)
  }
}

function parseSingleMultipartFile(req) {
  const contentType = req.headers['content-type'] || ''
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!boundaryMatch) return null
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`
  const body = req.rawBody
  if (!body?.length) return null
  const bodyText = body.toString('latin1')
  const partStart = bodyText.indexOf(boundary)
  if (partStart < 0) return null
  const headerStart = bodyText.indexOf('\r\n', partStart) + 2
  const headerEnd = bodyText.indexOf('\r\n\r\n', headerStart)
  if (headerStart < 2 || headerEnd < 0) return null
  const headers = bodyText.slice(headerStart, headerEnd)
  if (!/filename=/i.test(headers)) return null
  const contentTypeMatch = headers.match(/content-type:\s*([^\r\n]+)/i)
  const contentStart = headerEnd + 4
  const nextBoundary = bodyText.indexOf(`\r\n${boundary}`, contentStart)
  if (nextBoundary < 0) return null
  return {
    contentType: (contentTypeMatch?.[1] || '').trim().toLowerCase(),
    buffer: body.subarray(contentStart, nextBoundary)
  }
}

function isPng(buffer) {
  return buffer?.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
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
