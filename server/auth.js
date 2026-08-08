import crypto from 'node:crypto'
import { nanoid } from 'nanoid'
import { config } from './config.js'
import { db, upsertUser } from './db.js'

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  path: '/'
}

export function requireUser(req, res, next) {
  const sessionId = req.cookies.chat_session
  if (!sessionId) return res.status(401).json({ error: 'AUTH_REQUIRED' })
  const row = db.prepare(`
    SELECT sessions.id AS session_id, sessions.access_token, users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).get(sessionId)
  if (!row) return res.status(401).json({ error: 'AUTH_REQUIRED' })
  req.user = { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url }
  req.accessToken = row.access_token
  next()
}

export function authRoutes(app) {
  app.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(32).toString('base64url')
    res.cookie('oauth_state', state, { ...cookieOptions, maxAge: 10 * 60 * 1000 })
    const params = new URLSearchParams({
      client_id: config.oauthClientId,
      redirect_uri: config.oauthRedirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state
    })
    res.redirect(307, `${config.authBaseUrl}/oauth/authorize?${params}`)
  })

  app.get('/auth/callback', async (req, res, next) => {
    try {
      const expectedState = req.cookies.oauth_state
      if (!expectedState || expectedState !== req.query.state) {
        return res.status(400).send('Invalid OAuth state')
      }
      if (!config.oauthClientSecret) {
        return res.status(503).send('OAUTH_CLIENT_SECRET is not configured')
      }

      const tokenResponse = await fetch(`${config.authBaseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(req.query.code || ''),
          redirect_uri: config.oauthRedirectUri,
          client_id: config.oauthClientId,
          client_secret: config.oauthClientSecret
        })
      })
      if (!tokenResponse.ok) return res.status(502).send('Auth token exchange failed')
      const tokenPayload = await tokenResponse.json()
      const userInfo = tokenPayload.user || await fetchUserInfo(tokenPayload.access_token)
      const user = normalizeUser(userInfo)
      upsertUser(user)

      const sessionId = nanoid()
      db.prepare('INSERT INTO sessions (id, user_id, access_token, expires_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, user.id, tokenPayload.access_token, expiresAt(tokenPayload.expires_in))
      res.clearCookie('oauth_state', cookieOptions)
      res.cookie('chat_session', sessionId, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 })
      res.redirect(303, config.appUrl)
    } catch (error) {
      next(error)
    }
  })

  app.post('/auth/logout', requireUser, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.cookies.chat_session)
    res.clearCookie('chat_session', cookieOptions)
    res.json({ ok: true })
  })

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: req.user })
  })
}

async function fetchUserInfo(accessToken) {
  const response = await fetch(`${config.authBaseUrl}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) throw new Error('Auth userinfo failed')
  return response.json()
}

function normalizeUser(userInfo) {
  return {
    id: String(userInfo.sub || userInfo.id || userInfo.user_id),
    email: userInfo.email || null,
    name: userInfo.name || userInfo.username || userInfo.email || 'User',
    avatar_url: userInfo.picture || userInfo.avatar_url || null
  }
}

function expiresAt(seconds) {
  if (!seconds) return null
  return new Date(Date.now() + Number(seconds) * 1000).toISOString()
}
