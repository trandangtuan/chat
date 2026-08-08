import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Bot,
  Boxes,
  ChevronRight,
  LogOut,
  MessageSquare,
  Plus,
  Send,
  ServerCog,
  Sparkles,
  UserRound
} from 'lucide-react'
import './styles.css'

const api = {
  async get(path) {
    const response = await fetch(path, { credentials: 'include' })
    if (!response.ok) throw new Error(path)
    return response.json()
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(path)
    return response.json()
  }
}

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mcpServers, setMcpServers] = useState([])
  const [skills, setSkills] = useState([])
  const [mcpName, setMcpName] = useState('')
  const [skillName, setSkillName] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId),
    [activeId, conversations]
  )

  useEffect(() => {
    bootstrap()
  }, [])

  useEffect(() => {
    if (!activeId) return
    api.get(`/api/conversations/${activeId}/messages`).then((data) => setMessages(data.messages)).catch(() => setMessages([]))
  }, [activeId])

  async function bootstrap() {
    try {
      const identity = await api.get('/api/me')
      setUser(identity.user)
      const [conversationData, mcpData, skillData] = await Promise.all([
        api.get('/api/conversations'),
        api.get('/api/mcp-servers'),
        api.get('/api/skills')
      ])
      setConversations(conversationData.conversations)
      setActiveId(conversationData.conversations[0]?.id || null)
      setMcpServers(mcpData.mcpServers)
      setSkills(skillData.skills)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  async function createConversation() {
    const data = await api.post('/api/conversations', { title: 'New chat' })
    setConversations((current) => [data.conversation, ...current])
    setActiveId(data.conversation.id)
    setMessages([])
  }

  async function sendMessage(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || !activeId || sending) return
    const localUserId = `local-user-${Date.now()}`
    const assistantId = `stream-${Date.now()}`
    setDraft('')
    setSending(true)
    setMessages((current) => [
      ...current,
      { id: localUserId, role: 'user', content },
      { id: assistantId, role: 'assistant', content: '', streaming: true }
    ])
    try {
      const result = await streamMessage(activeId, content, (delta) => {
        setMessages((current) => current.map((message) => message.id === assistantId
          ? { ...message, content: `${message.content || ''}${delta}` }
          : message))
      })
      setMessages((current) => current.map((message) => {
        if (message.id === localUserId) return result.userMessage
        if (message.id === assistantId) return result.assistantMessage
        return message
      }))
      const refreshed = await api.get('/api/conversations')
      setConversations(refreshed.conversations)
    } catch {
      setMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, content: 'Không thể stream câu trả lời. Vui lòng thử lại.', streaming: false }
        : message))
    } finally {
      setSending(false)
    }
  }

  async function addMcpServer(event) {
    event.preventDefault()
    if (!mcpName.trim()) return
    const data = await api.post('/api/mcp-servers', { name: mcpName.trim(), transport: 'stdio', env: {} })
    setMcpServers((current) => [data.mcpServer, ...current])
    setMcpName('')
  }

  async function addSkill(event) {
    event.preventDefault()
    if (!skillName.trim() || !skillInstructions.trim()) return
    const data = await api.post('/api/skills', { name: skillName.trim(), instructions: skillInstructions.trim() })
    setSkills((current) => [data.skill, ...current])
    setSkillName('')
    setSkillInstructions('')
  }

  async function logout() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' })
    window.location.reload()
  }

  if (loading) {
    return <div className="center-screen"><Sparkles size={22} /> Loading workspace</div>
  }

  if (!user) {
    return (
      <main className="login-screen">
        <section className="login-visual">
          <div className="product-mark"><Sparkles size={22} /></div>
          <h1>TDShift Chat AI</h1>
          <p>ChatGPT-style workspace for many users, with SSO identity, private conversations, personal MCP servers, and personal skills.</p>
          <a className="primary-link" href="/auth/login"><UserRound size={18} /> Sign in with TDShift SSO</a>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon"><Sparkles size={18} /></div>
          <div><strong>TDShift Chat</strong><span>{user.email || user.id}</span></div>
        </div>
        <button className="new-chat" onClick={createConversation}><Plus size={18} /> New chat</button>
        <nav className="conversation-list">
          {conversations.map((conversation) => (
            <button key={conversation.id} className={conversation.id === activeId ? 'active' : ''} onClick={() => setActiveId(conversation.id)}>
              <MessageSquare size={16} />
              <span>{conversation.title}</span>
              <ChevronRight size={15} />
            </button>
          ))}
        </nav>
        <button className="logout-button" onClick={logout}><LogOut size={16} /> Sign out</button>
      </aside>

      <main className="chat-panel">
        <header className="topbar">
          <div><span>Private workspace</span><h2>{activeConversation?.title || 'Start a new chat'}</h2></div>
          <div className="status-pill"><i /> SSO connected</div>
        </header>

        <section className="messages">
          {!activeId && (
            <div className="empty">
              <Bot size={34} />
              <h1>How can I help?</h1>
              <button onClick={createConversation}><Plus size={17} /> Create your first chat</button>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="bubble-icon">{message.role === 'assistant' ? <Sparkles size={16} /> : <UserRound size={16} />}</div>
              <p>{message.streaming && !message.content ? <span className="thinking">Thinking...</span> : message.content}</p>
            </article>
          ))}
        </section>

        <form className="composer" onSubmit={sendMessage}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message TDShift Chat AI" disabled={!activeId} />
          <button disabled={!activeId || sending || !draft.trim()}><Send size={18} /></button>
        </form>
      </main>

      <aside className="settings-panel">
        <section>
          <h3><ServerCog size={17} /> MCP servers</h3>
          <form onSubmit={addMcpServer} className="inline-form">
            <input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="filesystem, postgres..." />
            <button><Plus size={16} /></button>
          </form>
          <div className="chips">
            {mcpServers.map((server) => <span key={server.id}>{server.name}</span>)}
            {!mcpServers.length && <small>No MCP servers yet</small>}
          </div>
        </section>

        <section>
          <h3><Boxes size={17} /> Skills</h3>
          <form onSubmit={addSkill} className="skill-form">
            <input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="Skill name" />
            <textarea value={skillInstructions} onChange={(event) => setSkillInstructions(event.target.value)} placeholder="Instructions for this skill" />
            <button><Plus size={16} /> Add skill</button>
          </form>
          <div className="skill-list">
            {skills.map((skill) => <article key={skill.id}><strong>{skill.name}</strong><p>{skill.instructions}</p></article>)}
            {!skills.length && <small>No personal skills yet</small>}
          </div>
        </section>
      </aside>
    </div>
  )
}

async function streamMessage(conversationId, content, onDelta) {
  const response = await fetch(`/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!response.ok || !response.body) throw new Error('STREAM_FAILED')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let result = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''
    for (const eventBlock of events) {
      const parsed = parseSseEvent(eventBlock, currentEvent)
      currentEvent = parsed.lastEvent
      if (!parsed.data) continue
      if (parsed.event === 'delta') onDelta(parsed.data.delta || '')
      if (parsed.event === 'done') result = parsed.data
      if (parsed.event === 'error') throw new Error(parsed.data.error || 'STREAM_FAILED')
    }
  }

  if (!result) throw new Error('STREAM_INCOMPLETE')
  return result
}

function parseSseEvent(block, fallbackEvent) {
  let event = fallbackEvent
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  return {
    event,
    lastEvent: event,
    data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null
  }
}

createRoot(document.getElementById('root')).render(<App />)
