import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config } from './config.js'
import { db } from './db.js'
import { authRoutes, requireUser } from './auth.js'
import { generateAssistantReply } from './ai.js'

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
    const assistant = await generateAssistantReply({ user: req.user, messages, skills, mcpServers })
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

app.get('/api/mcp-servers', requireUser, (req, res) => {
  res.json({ mcpServers: listMcpServers(req.user.id) })
})

app.post('/api/mcp-servers', requireUser, (req, res) => {
  const payload = z.object({
    name: z.string().min(1).max(80),
    transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
    command: z.string().max(500).optional().nullable(),
    url: z.string().max(500).optional().nullable(),
    env: z.record(z.string()).default({}),
    enabled: z.boolean().default(true)
  }).parse(req.body)
  const id = nanoid()
  db.prepare(`
    INSERT INTO mcp_servers (id, user_id, name, transport, command, url, env_json, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, payload.name, payload.transport, payload.command, payload.url, JSON.stringify(payload.env), payload.enabled ? 1 : 0)
  res.status(201).json({ mcpServer: db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) })
})

app.get('/api/skills', requireUser, (req, res) => {
  res.json({ skills: listSkills(req.user.id) })
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
    instructions: z.string().min(1).max(10000),
    enabled: z.boolean().default(true)
  }).parse(req.body)
  const id = nanoid()
  db.prepare('INSERT INTO skills (id, user_id, name, instructions, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, payload.name, payload.instructions, payload.enabled ? 1 : 0)
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
  return db.prepare('SELECT id, name, instructions, enabled, created_at, updated_at FROM skills WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((skill) => ({ ...skill, enabled: Boolean(skill.enabled) }))
}

function listMcpServers(userId) {
  return db.prepare('SELECT id, name, transport, command, url, env_json, enabled, created_at, updated_at FROM mcp_servers WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((server) => ({ ...server, env: JSON.parse(server.env_json || '{}'), enabled: Boolean(server.enabled), env_json: undefined }))
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
